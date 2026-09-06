/**
 * Resolução do IP do cliente atrás de proxy / Cloudflare.
 * IPs privados, loopback ou "unknown" não entram no limite de contas por IP.
 *
 * Migrado de legacy/backend/utils/clientIp.ts (sem mudança de comportamento —
 * já era bem escrito: prioriza header Cloudflare só com TRUST_CF_CONNECTING_IP=1
 * explícito, nunca confia em cf-ray sozinho).
 */
export type IpRequestLike = {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null };
};

/** Normaliza (trim, primeiro hop de XFF, IPv4 mapeado em IPv6). */
export function normalizeClientIp(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const IPV6_MAPPED_IPV4_PREFIX = '::ffff:';
  let s = String(raw).trim();
  if (!s) return null;
  if (s.includes(',')) s = s.split(',')[0].trim();
  if (s.startsWith(IPV6_MAPPED_IPV4_PREFIX)) s = s.slice(IPV6_MAPPED_IPV4_PREFIX.length);
  return s || null;
}

const IPV4_OCTET_MAX = 255;

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const OCTET_COUNT = 4;
  const parts = m.slice(1, 1 + OCTET_COUNT).map((p) => Number(p)) as [number, number, number, number];
  if (parts.some((p) => !Number.isFinite(p) || p > IPV4_OCTET_MAX)) return null;
  return parts;
}

// Blocos privados/reservados RFC 1918 / RFC 3927 — não são "inventados", são as faixas
// oficiais de IP não-roteável na internet pública.
const RFC1918_10_A = 10;
const RFC1918_172_A = 172;
const RFC1918_172_B_MIN = 16;
const RFC1918_172_B_MAX = 31;
const RFC1918_192_A = 192;
const RFC1918_192_B = 168;
const LOOPBACK_A = 127;
const LINK_LOCAL_A = 169;
const LINK_LOCAL_B = 254;
const UNSPECIFIED_A = 0;

/** IP público utilizável para limite de registo (evita CGNAT interno / proxy mal configurado). */
export function isUsablePublicClientIp(ip: string): boolean {
  const n = normalizeClientIp(ip);
  if (!n || n === 'unknown') return false;
  if (n === '::1' || n === '127.0.0.1') return false;

  const v4 = parseIpv4Octets(n);
  if (v4) {
    const [a, b] = v4;
    if (a === RFC1918_10_A) return false;
    if (a === RFC1918_172_A && b >= RFC1918_172_B_MIN && b <= RFC1918_172_B_MAX) return false;
    if (a === RFC1918_192_A && b === RFC1918_192_B) return false;
    if (a === LOOPBACK_A) return false;
    if (a === LINK_LOCAL_A && b === LINK_LOCAL_B) return false;
    if (a === UNSPECIFIED_A) return false;
    return true;
  }

  const lower = n.toLowerCase();
  if (lower === '::1') return false;
  if (lower.startsWith('fe80:')) return false;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false;
  return true;
}

/** IP a gravar em `registration_ip` / anti-abuso (null se não for público). */
export function resolveRegistrationIp(raw: string | null | undefined): string | null {
  const n = normalizeClientIp(raw);
  if (!n || !isUsablePublicClientIp(n)) return null;
  return n;
}

function headerFirst(req: IpRequestLike, name: string): string | null {
  const v = req.headers[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0) return String(v[0]);
  return null;
}

/**
 * IP do cliente para rate-limit, registo e referral.
 * Prioriza cabeçalhos Cloudflare APENAS quando `TRUST_CF_CONNECTING_IP=1` (env var explícita).
 * Nunca infere confiança pelo header `cf-ray` — esse header é totalmente controlável pelo
 * cliente e seria um vetor trivial de bypass de todos os rate-limiters baseados em IP.
 * Se `req.ip` for privado (proxy mal configurado), tenta o primeiro IP público em XFF / X-Real-IP.
 */
export function getClientIpFromRequest(req: IpRequestLike): string {
  const behindCloudflare = String(process.env.TRUST_CF_CONNECTING_IP || '').trim() === '1';

  const candidates: string[] = [];
  const push = (raw: string | null | undefined) => {
    const n = normalizeClientIp(raw);
    if (n) candidates.push(n);
  };

  if (behindCloudflare) {
    push(headerFirst(req, 'cf-connecting-ip'));
    push(headerFirst(req, 'true-client-ip'));
  }

  push(req.ip);

  const xff = headerFirst(req, 'x-forwarded-for');
  if (xff) {
    for (const part of xff.split(',')) push(part);
  }

  push(headerFirst(req, 'x-real-ip'));
  push(req.socket?.remoteAddress ?? null);

  for (const c of candidates) {
    if (isUsablePublicClientIp(c)) return c;
  }

  return candidates[0] || 'unknown';
}
