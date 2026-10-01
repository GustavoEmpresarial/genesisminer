/**
 * Decisão pura do CTA Admin no GameShell (após stop-impersonate).
 */
import { describe, expect, it } from 'vitest';
import { decideAdminCtaAction } from '../../../client/src/app/adminExit.js';
import { ADMIN_AFTER_STOP_IMPERSONATE_PATH } from '../../../client/src/app/pathRouting.js';

describe('decideAdminCtaAction', () => {
  it('stop ok → hard_nav para dashboard admin', () => {
    expect(decideAdminCtaAction({ ok: true }, { isAdmin: false })).toEqual({
      action: 'hard_nav',
      path: ADMIN_AFTER_STOP_IMPERSONATE_PATH
    });
    expect(decideAdminCtaAction({ ok: true }, null)).toEqual({
      action: 'hard_nav',
      path: ADMIN_AFTER_STOP_IMPERSONATE_PATH
    });
  });

  it('stop falha + isAdmin → enter_admin (admin na própria conta)', () => {
    expect(
      decideAdminCtaAction({ ok: false, error: 'Not impersonating' }, { isAdmin: true })
    ).toEqual({ action: 'enter_admin' });
  });

  it('stop falha sem isAdmin → alert com error da API', () => {
    expect(
      decideAdminCtaAction({ ok: false, error: 'Not impersonating' }, { isAdmin: false })
    ).toEqual({ action: 'alert', error: 'Not impersonating' });
    expect(decideAdminCtaAction({ ok: false, error: 'Network error' }, null)).toEqual({
      action: 'alert',
      error: 'Network error'
    });
    expect(decideAdminCtaAction({ ok: false }, undefined)).toEqual({
      action: 'alert',
      error: undefined
    });
  });
});
