/**
 * Dedicated mobile check-in page — full layout (drawer view).
 * Desktop keeps the sticky banner on Mining.
 */
import { CalendarCheck, Flame, Loader2, Snowflake, Timer, Trophy, Zap } from 'lucide-react';
import { useI18n, useT } from '../../../shared/i18n';
import { dateLocaleFor } from '../../../shared/utils/locale-format';
import { formatCheckinCountdown, isCheckinButtonDisabled } from '../lib/checkinCountdown';
import { useCheckin } from '../hooks/useCheckin';

type CheckinPageProps = {
  /** Refresh GameShell header / inventory after rewards. */
  onRewardGranted?: () => void | Promise<void>;
};

function CycleDots({ progress, size }: { progress: number; size: number }) {
  const filled = Math.max(0, Math.min(size, progress));
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-hidden>
      {Array.from({ length: size }, (_, i) => (
        <span
          key={i}
          className={`h-2.5 w-2.5 rounded-full transition-all duration-300 ${
            i < filled
              ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.55)]'
              : 'bg-slate-700/90 ring-1 ring-slate-600/60'
          }`}
        />
      ))}
    </div>
  );
}

export function CheckinPage({ onRewardGranted }: CheckinPageProps) {
  const t = useT();
  const { locale } = useI18n();
  const {
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
  } = useCheckin({ saveLoaded: true, onRewardGranted });

  const frozen = status?.frozen === true;
  const canAct = status != null && !isCheckinButtonDisabled(status) && !submitting && !loading;

  const statusHeadline = (() => {
    if (!status) return null;
    if (status.premiumWeeklyCheckin) {
      return frozen
        ? t('checkin.titlePremiumFrozen', {
            days: String(status.premiumIntervalDays),
            minUsdc: String(status.premiumMinUsdc)
          })
        : t('checkin.titlePremiumActive', {
            time: formatCheckinCountdown(status.nextResetMs)
          });
    }
    return frozen
      ? t('checkin.titleDailyFrozen')
      : t('checkin.titleDailyActive', {
          time: formatCheckinCountdown(status.nextResetMs)
        });
  })();

  const windowLine = (() => {
    if (!status) return null;
    if (status.premiumWeeklyCheckin) {
      if (frozen) return t('checkin.premiumWindowExpired');
      return t('checkin.premiumNextDue', { time: formatCheckinCountdown(status.nextResetMs) });
    }
    if (frozen) return t('checkin.dailyWindowExpired');
    if (status.canCheckinNow || status.nextCheckinAtMs == null) {
      return t('checkin.dailyWindowAvailable');
    }
    return t('checkin.dailyNextWindow', { time: formatCheckinCountdown(status.nextCheckinAtMs) });
  })();

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden text-slate-100">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(245,158,11,0.18),_transparent_55%),radial-gradient(ellipse_at_bottom,_rgba(15,23,42,0.9),_#020617_70%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-amber-500/10 to-transparent"
        aria-hidden
      />

      <div className="relative mx-auto flex w-full max-w-lg flex-1 flex-col gap-5 px-4 pb-10 pt-5 animate-in fade-in duration-300">
        <header className="space-y-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-amber-400/90">
            {t('checkin.pageEyebrow')}
          </p>
          <div className="flex items-start gap-3">
            <span
              className={`mt-0.5 inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border shadow-lg transition-transform duration-500 ${
                frozen
                  ? 'border-sky-400/40 bg-sky-500/15 text-sky-300 shadow-sky-950/40'
                  : 'border-amber-400/45 bg-gradient-to-br from-amber-500/30 to-amber-900/40 text-amber-100 shadow-amber-950/50'
              }`}
            >
              {frozen ? <Snowflake size={28} aria-hidden /> : <CalendarCheck size={28} aria-hidden />}
            </span>
            <div className="min-w-0 space-y-1.5">
              <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">
                {t('checkin.pageTitle')}
              </h1>
              <p className="text-sm leading-relaxed text-slate-400">{t('checkin.pageSubtitle')}</p>
            </div>
          </div>
        </header>

        {loading && !status ? (
          <div className="flex flex-1 items-center justify-center gap-2 py-16 text-slate-400">
            <Loader2 className="animate-spin text-amber-400" size={22} />
            <span className="text-sm font-medium">{t('checkin.loading')}</span>
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-red-500/35 bg-red-950/35 px-4 py-5 text-sm text-red-200">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 text-xs font-bold uppercase tracking-wider text-red-100 underline decoration-red-400/50 underline-offset-2"
            >
              {t('checkin.retry')}
            </button>
          </div>
        ) : status ? (
          <>
            <section className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-amber-500/25 bg-gradient-to-br from-amber-950/50 via-slate-950/80 to-slate-950/90 p-4 shadow-[inset_0_1px_0_rgba(251,191,36,0.12)]">
                <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-400/80">
                  <Flame size={12} aria-hidden />
                  {t('checkin.streak')}
                </div>
                <p className="font-mono text-4xl font-black tabular-nums text-amber-200">
                  {status.streak}
                </p>
                <p className="mt-1 text-xs text-slate-400">{t('checkin.days')}</p>
              </div>
              <div className="rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-950/40 via-slate-950/80 to-slate-950/90 p-4 shadow-[inset_0_1px_0_rgba(52,211,153,0.1)]">
                <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-emerald-400/80">
                  <Zap size={12} aria-hidden />
                  {t('checkin.bonusAccumulated')}
                </div>
                <p className="font-mono text-3xl font-black tabular-nums text-emerald-300">
                  {status.checkinBonusHps.toLocaleString(dateLocaleFor(locale), {
                    maximumFractionDigits: 2
                  })}
                </p>
                <p className="mt-1 text-xs text-slate-400">H/s</p>
              </div>
            </section>

            <section className="space-y-4 rounded-2xl border border-slate-700/70 bg-slate-950/70 p-4 backdrop-blur-sm">
              <div className="flex items-start gap-3">
                <span
                  className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                    frozen ? 'bg-sky-500/15 text-sky-300' : 'bg-emerald-500/15 text-emerald-300'
                  }`}
                >
                  {frozen ? <Snowflake size={18} aria-hidden /> : <Timer size={18} aria-hidden />}
                </span>
                <div className="min-w-0 space-y-1">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    {frozen ? t('checkin.pageStatusFrozen') : t('checkin.pageStatusActive')}
                  </p>
                  <p className="text-sm font-semibold leading-snug text-slate-100">{statusHeadline}</p>
                  {windowLine ? <p className="text-xs leading-relaxed text-slate-400">{windowLine}</p> : null}
                  {!status.canCheckinNow &&
                  status.nextCheckinAllowedMs != null &&
                  !frozen &&
                  status.premiumWeeklyCheckin ? (
                    <p className="text-xs text-slate-400">
                      {t('checkin.premiumAvailableIn', {
                        time: formatCheckinCountdown(status.nextCheckinAllowedMs)
                      })}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="space-y-2 border-t border-slate-800/90 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    <Trophy size={12} className="text-amber-500/90" aria-hidden />
                    {t('checkin.rewardCycle')}
                  </p>
                  <span className="font-mono text-xs text-amber-200/90">
                    {status.rewardCycleProgress}/{status.rewardCycleSize}
                  </span>
                </div>
                <CycleDots progress={status.rewardCycleProgress} size={status.rewardCycleSize} />
                {rewardHint ? <p className="text-xs leading-relaxed text-slate-400">{rewardHint}</p> : null}
              </div>
            </section>

            <div className="mt-auto space-y-3 pt-2">
              {toast ? (
                <p
                  className={`rounded-xl border px-3 py-2.5 text-center text-sm animate-in fade-in zoom-in-95 duration-200 ${
                    toastTone === 'err'
                      ? 'border-red-500/35 bg-red-950/40 text-red-200'
                      : 'border-emerald-500/35 bg-emerald-950/40 text-emerald-200'
                  }`}
                  role="status"
                >
                  {toast}
                </p>
              ) : null}

              <button
                type="button"
                onClick={() => void handleCheckin()}
                disabled={submitting || loading || isCheckinButtonDisabled(status)}
                className={`group relative w-full overflow-hidden rounded-2xl border px-4 py-4 text-center text-base font-black tracking-wide transition duration-200 disabled:cursor-not-allowed disabled:opacity-45 ${
                  canAct
                    ? 'border-amber-300/60 bg-gradient-to-b from-amber-500 to-amber-700 text-stone-950 shadow-[0_12px_40px_rgba(245,158,11,0.28)] hover:from-amber-400 hover:to-amber-600 active:scale-[0.98]'
                    : 'border-slate-600/70 bg-slate-800/80 text-slate-300'
                }`}
              >
                <span
                  className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full"
                  aria-hidden
                />
                {submitting ? (
                  <span className="relative inline-flex items-center gap-2">
                    <Loader2 className="animate-spin" size={18} /> {t('checkin.submitting')}
                  </span>
                ) : (
                  <span className="relative">{buttonLabel}</span>
                )}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
