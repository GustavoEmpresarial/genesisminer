/**
 * Verificação de captcha Cloudflare Turnstile (registo/login).
 *
 * Site key / enabled flag ficam no Node (config pública pro frontend).
 * A verificação (`siteverify`) vai sempre para `genesis-auth` via
 * {@link callAuthTurnstileVerify} — o worker owns o secret + enforce gate
 * (`CLOUDFLARE_TURNSTILE_ENABLED` + `SECRET_KEY` no container auth).
 * Fail-closed se `GENESIS_AUTH_URL` unset.
 */
import { getClientIpFromRequest, type IpRequestLike } from '../../core/http/client-ip.js';
import { callAuthTurnstileVerify } from '../../modules/auth/services/auth-worker-client.js';

type TurnstileVerifyOk = { ok: true };
type TurnstileVerifyErr = { ok: false; status: number; error: string };

/** Keep in sync with Rust `ERR_CAPTCHA_REQUIRED`. */
const ERR_CAPTCHA_REQUIRED = 'Complete the captcha before continuing.';
const HTTP_BAD_REQUEST = 400;

/** Site key pública, exposta ao frontend pra renderizar o widget Turnstile. */
export function getTurnstileSiteKey(): string {
  return String(process.env.CLOUDFLARE_TURNSTILE_SITE_KEY || '').trim();
}

/**
 * `true` quando o feature flag e a site key pública estão configurados.
 * Secret fica só no auth worker — não exige `SECRET_KEY` no `app`.
 */
export function isTurnstileEnabled(): boolean {
  return (
    String(process.env.CLOUDFLARE_TURNSTILE_ENABLED || '0').trim() === '1' &&
    getTurnstileSiteKey().length > 0
  );
}

/**
 * Valida `token` via auth worker (Turnstile siteverify).
 *
 * Se Node considera Turnstile ligado e o token vem vazio → 400 local
 * (não chama o worker). Worker: ENABLED+SECRET; misconfigured → 503.
 *
 * @param req - Usado só para extrair o IP do cliente (`remoteip` opcional).
 * @param token - Valor bruto vindo do body (tipo não confiável → `unknown`).
 */
export async function verifyTurnstileToken(
  req: IpRequestLike,
  token: unknown
): Promise<TurnstileVerifyOk | TurnstileVerifyErr> {
  const response = typeof token === 'string' ? token.trim() : '';
  if (isTurnstileEnabled() && response.length === 0) {
    return { ok: false, status: HTTP_BAD_REQUEST, error: ERR_CAPTCHA_REQUIRED };
  }
  const remoteip = getClientIpFromRequest(req);
  const remoteipOpt =
    remoteip && remoteip !== 'unknown' ? remoteip : undefined;
  return callAuthTurnstileVerify({
    token: response,
    remoteip: remoteipOpt
  });
}
