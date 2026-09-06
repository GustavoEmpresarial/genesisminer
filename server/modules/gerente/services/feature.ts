/**
 * Kill-switch da Gerência. Default: desligado. Ligar com `ACCOUNT_MANAGER_ENABLED=1`.
 *
 * Migrado de legacy/backend/modules/account-manager/accountManager.feature.ts (verbatim).
 */
export function isAccountManagerEnabled(): boolean {
  const v = String(process.env.ACCOUNT_MANAGER_ENABLED ?? '0').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
