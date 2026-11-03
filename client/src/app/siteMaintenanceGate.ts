/** Kill-switch de site: sessão OU `/api/site-status`. Admin passa; landing/jogo bloqueiam. */

/** Hostname of production `https://genesisdao.tech` (mailer DEFAULT_PUBLIC_BASE_URL_PROD). */
export const PRINCIPAL_PUBLIC_HOST = 'genesisdao.tech';

const WWW_PREFIX = 'www.';

export function normalizeRequestHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  const colon = host.lastIndexOf(':');
  if (colon > 0) {
    const port = host.slice(colon + 1);
    if (port.length > 0 && port.split('').every((c) => c >= '0' && c <= '9')) {
      return host.slice(0, colon);
    }
  }
  return host;
}

export function isPrincipalPublicHost(hostname: string): boolean {
  const host = normalizeRequestHost(hostname);
  return host === PRINCIPAL_PUBLIC_HOST || host === `${WWW_PREFIX}${PRINCIPAL_PUBLIC_HOST}`;
}

export function resolveMaintenanceFlag(
  sessionFlag: boolean | undefined,
  statusFlag: boolean | undefined
): boolean {
  return sessionFlag === true || statusFlag === true;
}

export function shouldBlockGameAndLanding(
  maintenanceOn: boolean,
  isAdmin: boolean,
  hostname: string
): boolean {
  return maintenanceOn && !isAdmin && isPrincipalPublicHost(hostname);
}
