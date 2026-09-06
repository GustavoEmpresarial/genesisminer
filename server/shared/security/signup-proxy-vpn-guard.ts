/**
 * Bloqueio de cadastro via proxy/VPN/Tor/hosting, opcional — usa a API
 * externa proxycheck.io pra classificar o IP de quem está a criar conta;
 * existe pra dificultar farms de conta multi-accounting (indicação, bônus
 * de cadastro, etc.) escondidas atrás de VPN/proxy.
 *
 * Desligado por padrão: só ativa com `SIGNUP_ANTI_PROXY_VPN_ENABLED=1` e
 * `PROXYCHECK_API_KEY` configurada (ver {@link isSignupProxyVpnGuardEnabled}).
 * Fail-open é configurável via `SIGNUP_ANTI_PROXY_VPN_ALLOW_ON_ERROR`: por
 * padrão, se a API externa falhar ou não devolver veredito reconhecível, o
 * cadastro é **bloqueado** (fail-closed) — só vira fail-open se essa env
 * estiver explicitamente ligada (aceitar o risco de deixar passar cadastros
 * não verificados em vez de derrubar o cadastro por indisponibilidade
 * terceirizada).
 *
 * IP privado/loopback/não-roteável nunca é consultado na API externa (ver
 * `isUsablePublicClientIp`) — sempre aprovado, porque não faz sentido pedir
 * reputação de um IP que não é público (dev local, atrás de proxy interno
 * mal configurado).
 *
 * Migrado de legacy/backend/utils/signupProxyVpnGuard.ts. Único ajuste: import de
 * `clientIp` aponta pro novo local em `../../core/http/client-ip.ts`.
 */
import { isUsablePublicClientIp, normalizeClientIp } from '../../core/http/client-ip.js';

type SignupIpGuardOk = { ok: true };
type SignupIpGuardErr = {
  ok: false;
  status: number;
  error: string;
  code: 'SIGNUP_PROXY_VPN_BLOCKED' | 'SIGNUP_IP_INTEL_UNAVAILABLE';
  details?: Record<string, unknown>;
};

function envEnabled(name: string, fallback = '0'): boolean {
  return String(process.env[name] || fallback).trim() === '1';
}

function parseBoolish(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const s = String(value || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

function parseNumeric(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `true` só quando o feature flag está ligado e a API key está configurada. */
export function isSignupProxyVpnGuardEnabled(): boolean {
  return (
    envEnabled('SIGNUP_ANTI_PROXY_VPN_ENABLED') &&
    String(process.env.PROXYCHECK_API_KEY || '').trim().length > 0
  );
}

/**
 * Consulta a reputação de `clientIpRaw` e decide se o cadastro pode prosseguir.
 *
 * @returns `{ ok: true }` quando o guard está desligado, o IP não é público,
 *   ou a API não sinaliza proxy/VPN/Tor/hosting. `{ ok: false, code:
 *   'SIGNUP_PROXY_VPN_BLOCKED' }` (`403`) quando algum desses sinais é
 *   detectado. `{ ok: false, code: 'SIGNUP_IP_INTEL_UNAVAILABLE' }` (`503`)
 *   quando a API externa falha/não responde veredito reconhecível — a menos
 *   que `SIGNUP_ANTI_PROXY_VPN_ALLOW_ON_ERROR=1`, caso em que vira `ok: true`.
 */
export async function verifySignupIpNotProxyVpn(clientIpRaw: string): Promise<SignupIpGuardOk | SignupIpGuardErr> {
  if (!isSignupProxyVpnGuardEnabled()) return { ok: true };

  const clientIp = normalizeClientIp(clientIpRaw);
  if (!clientIp || !isUsablePublicClientIp(clientIp)) return { ok: true };

  const apiKey = String(process.env.PROXYCHECK_API_KEY || '').trim();
  const allowOnError = envEnabled('SIGNUP_ANTI_PROXY_VPN_ALLOW_ON_ERROR', '0');

  try {
    const qs = new URLSearchParams({ key: apiKey, vpn: '3', asn: '1', risk: '1' });
    const res = await fetch(`https://proxycheck.io/v2/${encodeURIComponent(clientIp)}?${qs.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (allowOnError) return { ok: true };
      return {
        ok: false,
        status: 503,
        code: 'SIGNUP_IP_INTEL_UNAVAILABLE',
        error: 'Could not validate signup network right now. Please try again in a moment.',
        details: { clientIp, httpStatus: res.status }
      };
    }
    const row = (data?.[clientIp] && typeof data[clientIp] === 'object' ? data[clientIp] : {}) as Record<
      string,
      unknown
    >;
    const detections =
      row.detections && typeof row.detections === 'object' ? (row.detections as Record<string, unknown>) : {};

    const proxy = parseBoolish(row.proxy) || parseBoolish(detections.proxy);
    const vpn = parseBoolish(row.vpn) || parseBoolish(detections.vpn) || String(row.type || '').toLowerCase() === 'vpn';
    const tor = parseBoolish(row.tor) || parseBoolish(detections.tor) || String(row.type || '').toLowerCase() === 'tor';
    const hosting =
      parseBoolish(row.hosting) ||
      parseBoolish(detections.hosting) ||
      String(row.type || '').toLowerCase() === 'hosting';
    const risk = parseNumeric(row.risk) ?? parseNumeric(detections.risk) ?? 0;

    if (proxy || vpn || tor || hosting) {
      return {
        ok: false,
        status: 403,
        code: 'SIGNUP_PROXY_VPN_BLOCKED',
        error: 'Signup blocked: disable VPN, proxy, or anonymous network and try again.',
        details: { clientIp, proxy, vpn, tor, hosting, risk, type: row.type ?? null, provider: row.provider ?? null }
      };
    }

    const verdictKnown =
      Object.prototype.hasOwnProperty.call(row, 'proxy') ||
      Object.prototype.hasOwnProperty.call(row, 'vpn') ||
      Object.prototype.hasOwnProperty.call(row, 'type') ||
      Object.prototype.hasOwnProperty.call(row, 'risk');
    if (!verdictKnown) {
      if (allowOnError) return { ok: true };
      return {
        ok: false,
        status: 503,
        code: 'SIGNUP_IP_INTEL_UNAVAILABLE',
        error: 'Could not validate signup network right now. Please try again in a moment.',
        details: { clientIp, proxycheckStatus: data?.status ?? null }
      };
    }

    return { ok: true };
  } catch (error: unknown) {
    if (allowOnError) return { ok: true };
    return {
      ok: false,
      status: 503,
      code: 'SIGNUP_IP_INTEL_UNAVAILABLE',
      error: 'Could not validate signup network right now. Please try again in a moment.',
      details: { clientIp, message: error instanceof Error ? error.message : String(error) }
    };
  }
}
