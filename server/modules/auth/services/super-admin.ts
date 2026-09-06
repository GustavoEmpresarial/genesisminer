/**
 * Resolução de super-admin — só a coluna `is_super_admin` do banco conta.
 *
 * Legado (`legacy/backend/utils/legacySuperAdmin.ts`) tinha uma allowlist de e-mail
 * hardcoded no código-fonte (`kellyreg@gmail.com`) que promovia essa conta a
 * super-admin automaticamente a cada boot do servidor (`ensureAdminSuperAdminSchema`
 * em `server.ts`, ver docs/architecture/DECISIONS.md #6). Removido por decisão
 * explícita — não existe mais bypass por e-mail, nem no código nem em escrita
 * automática no banco. Se alguém precisar ser super-admin, isso é feito via coluna
 * `is_super_admin` diretamente (admin com acesso a banco/painel), não via deploy.
 */
function truthyDbInt(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0;
}

export function resolveIsSuperAdminFromUserRow(row: { is_super_admin?: unknown }): boolean {
  return truthyDbInt(row.is_super_admin);
}
