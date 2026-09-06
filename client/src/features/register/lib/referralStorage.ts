import { AUTH_REFERRAL_MAX } from '../../../shared/constants/authLimits';
import { GENESIS_REF_SS } from './registerValidation';

/** Lê ?ref= ou sessionStorage; persiste na sessão. */
export function readAndPersistReferralFromLocation(): string {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('ref');
  if (ref) {
    const trimmed = ref.slice(0, AUTH_REFERRAL_MAX);
    try {
      sessionStorage.setItem(GENESIS_REF_SS, trimmed);
    } catch {
      /* ignore */
    }
    return trimmed;
  }
  try {
    const saved = sessionStorage.getItem(GENESIS_REF_SS);
    return saved ? saved.slice(0, AUTH_REFERRAL_MAX) : '';
  } catch {
    return '';
  }
}

export function clearPersistedReferral(): void {
  try {
    sessionStorage.removeItem(GENESIS_REF_SS);
  } catch {
    /* ignore */
  }
}
