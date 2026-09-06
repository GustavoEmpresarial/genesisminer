/**
 * Feature flags exposed to the client session/login payload.
 * Shared so POST /api/login and GET /api/session stay in sync.
 */
import { isAccountManagerEnabled } from '../../gerente/services/feature.js';
import { anyMergeTypeEnabled, loadMergeSettings } from '../../merge/services/settings.js';

export async function resolveClientFeatureFlags(): Promise<{
  accountManagerEnabled: boolean;
  mergeEnabled: boolean;
}> {
  const accountManagerEnabled = isAccountManagerEnabled();
  let mergeEnabled = true;
  try {
    const ms = await loadMergeSettings();
    mergeEnabled = ms.enabled !== false && anyMergeTypeEnabled(ms);
  } catch {
    /* default on — mirror legacy bootstrap */
  }
  return { accountManagerEnabled, mergeEnabled };
}
