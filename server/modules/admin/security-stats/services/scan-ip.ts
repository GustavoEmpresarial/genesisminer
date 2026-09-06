/**
 * Filtro de IPs nas listagens de scan (legado `isUsefulSecurityScanIp` em server.ts):
 * público utilizável e fora de ranges de edge Cloudflare conhecidos.
 */
import { isUsablePublicClientIp } from '../../../../core/http/client-ip.js';

function parseIpv4Parts(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1, 5).map((p) => Number(p)) as [number, number, number, number];
  if (parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return null;
  return parts;
}

function isIpv4InCidr(ip: string, base: [number, number, number, number], prefix: number): boolean {
  const parts = parseIpv4Parts(ip);
  if (!parts) return false;
  let ipNum = 0;
  let baseNum = 0;
  for (let i = 0; i < 4; i += 1) {
    ipNum = (ipNum << 8) | parts[i];
    baseNum = (baseNum << 8) | base[i];
  }
  const shift = 32 - prefix;
  const mask = shift <= 0 ? 0xffffffff : (0xffffffff << shift) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

const CF_EDGE_CIDRS: Array<[[number, number, number, number], number]> = [
  [[173, 245, 48, 0], 20],
  [[103, 21, 244, 0], 22],
  [[103, 22, 200, 0], 22],
  [[103, 31, 4, 0], 22],
  [[141, 101, 64, 0], 18],
  [[108, 162, 192, 0], 18],
  [[190, 93, 240, 0], 20],
  [[188, 114, 96, 0], 20],
  [[197, 234, 240, 0], 22],
  [[198, 41, 128, 0], 17],
  [[162, 158, 0, 0], 15],
  [[104, 16, 0, 0], 13],
  [[104, 24, 0, 0], 14],
  [[172, 64, 0, 0], 13],
  [[131, 0, 72, 0], 22]
];

export function isKnownProxyEdgeIpForSecurity(ip: string): boolean {
  const n = String(ip || '').trim();
  if (!n) return false;
  return CF_EDGE_CIDRS.some(([base, prefix]) => isIpv4InCidr(n, base, prefix));
}

export function isUsefulSecurityScanIp(ip: string): boolean {
  return isUsablePublicClientIp(ip) && !isKnownProxyEdgeIpForSecurity(ip);
}
