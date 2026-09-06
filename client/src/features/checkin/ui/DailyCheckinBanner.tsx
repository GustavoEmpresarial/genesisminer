/**
 * Daily / premium check-in banner (sticky above mining room on desktop).
 * API: `features/checkin/api/checkin.ts` · DECISIONS #97 / #98.
 */
import { CalendarCheck, Loader2, Snowflake, Trophy } from 'lucide-react';
import { useI18n } from '../../../shared/i18n';
import { dateLocaleFor } from '../../../shared/utils/locale-format';
import { formatCheckinCountdown, isCheckinButtonDisabled } from '../lib/checkinCountdown';
import { useCheckin } from '../hooks/useCheckin';

type DailyCheckinBannerProps = {
  /** Avoid requests before mining save is ready. */
  saveLoaded: boolean;
  /** Reload inventory / header after a successful check-in or reward grant. */
  onRewardGranted?: () => void;
};

export function DailyCheckinBanner({ saveLoaded, onRewardGranted }: DailyCheckinBannerProps) {
  const { locale } = useI18n();
  const {
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
  } = useCheckin({ saveLoaded, onRewardGranted });

  if (!saveLoaded) return null;

  return (
    <div className="sticky top-0 z-20 shrink-0 border-b border-amber-500/25 bg-slate-950/90 backdrop-blur-sm dark:bg-black/50">
      <div className="mx-auto flex max-w-7xl flex-col gap-2.5 px-3 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:px-4 sm:py-2 sm:text-sm">
        <div className="flex min-w-0 items-start gap-2.5">
          {status?.frozen ? (
            <Snowflake className="mt-0.5 shrink-0 text-sky-400" size={18} aria-hidden />
          ) : (
            <CalendarCheck className="mt-0.5 shrink-0 text-emerald-400" size={18} aria-hidden />
          )}
          <div className="min-w-0 space-y-1">
            {loading && !status ? (
              <p className="flex items-center gap-2 text-slate-400">
                <Loader2 className="animate-spin" size={14} /> {t('checkin.loading')}
              </p>
            ) : error ? (
              <p className="text-red-300">
                {error}{' '}
                <button
                  type="button"
                  onClick={() => void load()}
                  className="underline decoration-red-400/60 underline-offset-2 hover:text-red-200"
                >
                  {t('checkin.retry')}
                </button>
              </p>
            ) : status ? (
              <>
                <p className="text-[13px] font-bold leading-snug text-slate-100 sm:text-sm">
                  {status.premiumWeeklyCheckin
                    ? status.frozen
                      ? t('checkin.titlePremiumFrozen', {
                          days: String(status.premiumIntervalDays),
                          minUsdc: String(status.premiumMinUsdc)
                        })
                      : t('checkin.titlePremiumActive', {
                          time: formatCheckinCountdown(status.nextResetMs)
                        })
                    : status.frozen
                      ? t('checkin.titleDailyFrozen')
                      : t('checkin.titleDailyActive', {
                          time: formatCheckinCountdown(status.nextResetMs)
                        })}
                </p>
                <p className="text-[11px] leading-relaxed text-slate-400 sm:text-xs">
                  {t('checkin.streak')}{' '}
                  <span className="font-mono text-amber-300">{status.streak}</span> {t('checkin.days')} ·{' '}
                  {status.premiumWeeklyCheckin ? (
                    <>
                      {status.frozen
                        ? t('checkin.premiumWindowExpired')
                        : t('checkin.premiumNextDue', {
                            time: formatCheckinCountdown(status.nextResetMs)
                          })}{' '}
                      {!status.canCheckinNow && status.nextCheckinAllowedMs != null && !status.frozen ? (
                        <>
                          ·{' '}
                          {t('checkin.premiumAvailableIn', {
                            time: formatCheckinCountdown(status.nextCheckinAllowedMs)
                          })}
                        </>
                      ) : null}
                    </>
                  ) : (
                    <>
                      {status.frozen
                        ? t('checkin.dailyWindowExpired')
                        : status.canCheckinNow || status.nextCheckinAtMs == null
                          ? t('checkin.dailyWindowAvailable')
                          : t('checkin.dailyNextWindow', {
                              time: formatCheckinCountdown(status.nextCheckinAtMs)
                            })}
                    </>
                  )}{' '}
                  · {t('checkin.rewardCycle')}{' '}
                  <span className="text-amber-200/90">
                    {status.rewardCycleProgress}/{status.rewardCycleSize}
                  </span>{' '}
                  <Trophy className="inline align-text-bottom text-amber-500/90" size={14} aria-hidden />{' '}
                  {rewardHint}
                  {status.checkinBonusHps > 0 ? (
                    <>
                      {' '}
                      · {t('checkin.bonusAccumulated')}{' '}
                      <span className="font-mono text-emerald-300">
                        {status.checkinBonusHps.toLocaleString(dateLocaleFor(locale), {
                          maximumFractionDigits: 2
                        })}{' '}
                        H/s
                      </span>
                    </>
                  ) : null}
                </p>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-1 sm:items-end">
          {toast ? (
            <p
              className={`max-w-md text-right text-[11px] sm:text-xs ${
                toastTone === 'err' ? 'text-red-300/95' : 'text-emerald-300/95'
              }`}
            >
              {toast}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void handleCheckin()}
            disabled={submitting || loading || isCheckinButtonDisabled(status)}
            className="min-h-10 w-full whitespace-normal rounded-lg border border-amber-500/50 bg-amber-600/25 px-3 py-2 text-center text-xs font-bold leading-snug text-amber-100 transition hover:bg-amber-600/35 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:w-auto sm:whitespace-nowrap sm:py-1.5 sm:text-sm"
          >
            {submitting ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="animate-spin" size={14} /> {t('checkin.submitting')}
              </span>
            ) : (
              buttonLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
