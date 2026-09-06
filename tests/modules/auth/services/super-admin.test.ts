import { describe, expect, it } from 'vitest';
import { resolveIsSuperAdminFromUserRow } from '../../../../server/modules/auth/services/super-admin.js';

describe('resolveIsSuperAdminFromUserRow', () => {
  it('true quando is_super_admin=1', () => {
    expect(resolveIsSuperAdminFromUserRow({ is_super_admin: 1 })).toBe(true);
  });

  it('false quando is_super_admin=0/ausente', () => {
    expect(resolveIsSuperAdminFromUserRow({ is_super_admin: 0 })).toBe(false);
    expect(resolveIsSuperAdminFromUserRow({})).toBe(false);
  });

  it('não existe bypass por e-mail — só a coluna do banco conta', () => {
    // Regressão intencional: legado tinha allowlist de e-mail hardcoded promovendo
    // uma conta específica a super-admin automaticamente. Removido (ver DECISIONS.md #6).
    expect(resolveIsSuperAdminFromUserRow({ is_super_admin: 0 })).toBe(false);
  });

  it('aceita valores truthy não-1 (ex.: string "1" vinda de driver de banco)', () => {
    expect(resolveIsSuperAdminFromUserRow({ is_super_admin: '1' })).toBe(true);
  });
});
