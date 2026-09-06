/**
 * i18n helpers for check-in reward copy (status banner + post-claim toast).
 */
import type { CheckinPerformPayload, CheckinStatusPayload } from '../api/checkin';

type TFn = (key: string, vars?: Record<string, string>) => string;

export function buildCheckinRewardHint(s: CheckinStatusPayload, t: TFn): string {
  const amount = s.premiumWeeklyCheckin ? s.weeklyRewardAmount : s.dailyRewardAmount;
  let base: string;
  if (s.rewardType === 'hashrate') {
    base = s.premiumWeeklyCheckin
      ? t('checkin.hintPremiumHash', { amount: String(amount) })
      : t('checkin.hintDailyHash', { amount: String(amount) });
  } else {
    base = s.premiumWeeklyCheckin
      ? t('checkin.hintPremiumItem', { amount: String(amount), unit: s.rewardUnit })
      : t('checkin.hintDailyItem', { amount: String(amount), unit: s.rewardUnit });
  }
  if (!s.premiumWeeklyCheckin && s.streakRewardEnabled && s.streakRewardItemId) {
    const dur =
      s.streakRewardDurationLabel || `${s.streakRewardDurationAmount} ${s.streakRewardDurationUnit}`;
    base += ` ${t('checkin.hintStreakMachine', { duration: dur })}`;
  }
  return base;
}

export function formatCheckinRewardToast(data: CheckinPerformPayload, t: TFn): string {
  if (data.rewardGranted <= 0) return '';
  if (data.rewardType === 'hashrate') {
    return t('checkin.toastHash', {
      amount: String(data.rewardGranted),
      unit: data.rewardUnit
    });
  }
  const kind = data.rewardType === 'battery' ? t('checkin.kindBattery') : t('checkin.kindItem');
  return t('checkin.toastItem', {
    amount: String(data.rewardGranted),
    kind,
    unit: data.rewardUnit
  });
}

export function formatCheckinStreakToast(data: CheckinPerformPayload, t: TFn): string {
  if (data.streakRewardGranted <= 0) return '';
  const name =
    data.streakRewardGrantedItemName || data.streakRewardGrantedItemId || t('checkin.machineFallback');
  const dur = data.streakRewardGrantedDurationLabel
    ? t('checkin.toastStreakDuration', { duration: data.streakRewardGrantedDurationLabel })
    : '';
  return t('checkin.toastStreak', { name, duration: dur });
}
