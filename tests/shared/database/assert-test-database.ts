/**
 * Guarda anti-produção para harness PG / smoke.
 *
 * Hosts de produção extraídos de `scripts/deploy/vm_config_secret.example.py`
 * (não importar o secret real) e do domínio público do mesmo stack.
 */

/** IP de produção em `scripts/deploy/vm_config_secret.example.py`. */
export const PROD_DATABASE_HOST_IP = '177.7.47.139';

/** Domínio público do stack de produção. */
export const PROD_DATABASE_HOST_DOMAIN = 'genesisdao.tech';

export const PROD_DATABASE_HOSTS: ReadonlySet<string> = new Set([
  PROD_DATABASE_HOST_IP,
  PROD_DATABASE_HOST_DOMAIN
]);

/**
 * Recusa imediatamente URLs postgres cujo hostname seja de produção.
 * Falha também se o URL não for parseável — fail-closed.
 */
export function assertTestDatabaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`DATABASE_URL inválida — não é um URL postgres parseável.`);
  }
  const host = parsed.hostname.toLowerCase();
  if (PROD_DATABASE_HOSTS.has(host)) {
    throw new Error(
      `Recusado: DATABASE_URL aponta para host de produção (${host}). Testes PG só podem correr contra base de teste.`
    );
  }
}
