/**
 * Pure decision for GameShell "Admin" CTA after POST stop-impersonate.
 * Always call stop first; do not gate on client `isImpersonating` alone.
 */
import { ADMIN_AFTER_STOP_IMPERSONATE_PATH } from './pathRouting';

export type AdminCtaStopResult = { ok: boolean; error?: string };

export type AdminCtaUserFlags = { isAdmin?: boolean } | null | undefined;

export type AdminCtaDecision =
  | { action: 'hard_nav'; path: typeof ADMIN_AFTER_STOP_IMPERSONATE_PATH }
  | { action: 'enter_admin' }
  | { action: 'alert'; error: string | undefined };

export function decideAdminCtaAction(
  stopResult: AdminCtaStopResult,
  user: AdminCtaUserFlags
): AdminCtaDecision {
  if (stopResult.ok) {
    return { action: 'hard_nav', path: ADMIN_AFTER_STOP_IMPERSONATE_PATH };
  }
  if (user?.isAdmin) {
    return { action: 'enter_admin' };
  }
  return { action: 'alert', error: stopResult.error };
}
