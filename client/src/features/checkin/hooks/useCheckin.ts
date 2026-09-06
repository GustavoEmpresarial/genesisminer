/**
 * Shared check-in load / perform / toast state for banner + mobile page.
 */
import { useCallback, useEffect, useState } from 'react';
import { getCheckinStatus, postCheckin, type CheckinStatusPayload } from '../api/checkin';
import { mapApiErrorToMessage } from '../../../shared/api/client-errors';
import { useT } from '../../../shared/i18n';
import { formatCheckinCountdown } from '../lib/checkinCountdown';
import {
  buildCheckinRewardHint,
  formatCheckinRewardToast,
  formatCheckinStreakToast
} from '../lib/checkinRewardCopy';

export type CheckinToastTone = 'ok' | 'err';

export function useCheckin(opts: {
  saveLoaded: boolean;
  onRewardGranted?: () => void | Promise<void>;
}) {
  const { saveLoaded, onRewardGranted } = opts;
  const t = useT();
  const [status, setStatus] = useState<CheckinStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastTone, setToastTone] = useState<CheckinToastTone>('ok');
  const [, setNowTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick((v) => (v + 1) % 1_000_000), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const out = await getCheckinStatus();
      if (out.ok) {
        setStatus(out.data);
      } else {
        setError(mapApiErrorToMessage(out.error, t, 'checkin'));
        setStatus(null);
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!saveLoaded) return;
    void load();
  }, [saveLoaded, load]);

  const rewardHint = status ? buildCheckinRewardHint(status, t) : '';

  const buttonLabel = (() => {
    if (submitting) return null;
    if (status?.premiumWeeklyCheckin && !status.canCheckinNow && (status.todayCheckedIn || status.frozen)) {
      return status.nextCheckinAllowedMs != null
        ? t('checkin.btnWait', { time: formatCheckinCountdown(status.nextCheckinAllowedMs) })
        : t('checkin.btnWaitPremium');
    }
    if (status?.todayCheckedIn && !status.frozen) {
      const nextAt = status.nextCheckinAtMs ?? status.nextResetMs;
      return t('checkin.btnActive', { time: formatCheckinCountdown(nextAt) });
    }
    return t('checkin.btnDo');
  })();

  const handleCheckin = async () => {
    setSubmitting(true);
    setToast(null);
    try {
      const out = await postCheckin();
      if (out.ok) {
        setStatus(out.data);
        setToastTone('ok');
        const parts: string[] = [];
        if (out.data.rewardGranted > 0) {
          parts.push(formatCheckinRewardToast(out.data, t));
        }
        if (out.data.streakRewardGranted > 0) {
          parts.push(formatCheckinStreakToast(out.data, t));
        }
        const shouldNotifyReward =
          out.data.performed === true ||
          out.data.rewardGranted > 0 ||
          out.data.streakRewardGranted > 0;
        if (shouldNotifyReward) {
          void onRewardGranted?.();
        }
        if (parts.length > 0) {
          setToast(parts.filter(Boolean).join(' '));
        } else if (out.data.performed) {
          if (out.data.premiumWeeklyCheckin) {
            setToast(t('checkin.toastPremiumDone', { days: String(out.data.premiumIntervalDays) }));
          } else {
            setToast(t('checkin.toastDailyDone'));
          }
        } else {
          setToast(t('checkin.toastAlreadyDone'));
        }
      } else {
        setToastTone('err');
        setToast(mapApiErrorToMessage(out.error, t, 'checkin'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return {
    t,
    status,
    error,
    loading,
    submitting,
    toast,
    toastTone,
    rewardHint,
    buttonLabel,
    load,
    handleCheckin
  };
}
