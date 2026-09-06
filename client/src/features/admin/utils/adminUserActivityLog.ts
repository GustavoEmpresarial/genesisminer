import type { GameUserActivityEntry } from '../lib/adminTypes';

/** @deprecated Use formatActivityEvent / display da API */
export function formatUserActivityMeta(meta: GameUserActivityEntry['meta']): string {
  if (meta == null || typeof meta !== 'object') return '—';
  try {
    const s = JSON.stringify(meta);
    return s.length > 420 ? `${s.slice(0, 420)}…` : s;
  } catch {
    return '—';
  }
}

export { formatAccountCreatedBrt } from './activityEventFormatterHelpers';

export {
  ACTIVITY_LOG_FILTER_GROUPS,
  filterUserActivityLogs,
  formatActivityEvent
} from './activityEventFormatter';
