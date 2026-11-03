import { useEffect, useState, type ReactNode } from 'react';
import { ExternalLink, Mail, Timer, Vote, Zap } from 'lucide-react';
import { useI18n, useT } from '../../../shared/i18n';
import { getTopIdleStatus, type TopIdleStatus } from '../../../shared/api/topidle';
import { formatInstantMs } from '../../../shared/utils/locale-format';
import { formatCheckinCountdown } from '../../checkin/lib/checkinCountdown';
import { TOPIDLE_VOTE_REWARD_HPS, TOPIDLE_VOTE_URL } from '../lib/constants';

const HPS_LABEL = String(TOPIDLE_VOTE_REWARD_HPS);

export function TopIdleVotePage() {
  const t = useT();
  const { locale } = useI18n();
  const [status, setStatus] = useState<TopIdleStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getTopIdleStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const voteUrl = status?.voteUrl || TOPIDLE_VOTE_URL;
  const nextMs = status?.nextVoteAtMs ?? null;
  const waiting = nextMs != null && nextMs > Date.now();
  const hps = { hps: HPS_LABEL };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden text-slate-100">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(16,185,129,0.22),_transparent_55%),radial-gradient(ellipse_at_bottom,_rgba(15,23,42,0.92),_#020617_72%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-emerald-400/15 to-transparent"
        aria-hidden
      />

      <div className="relative mx-auto flex w-full max-w-lg flex-1 flex-col gap-5 px-4 pb-10 pt-5 animate-in fade-in duration-300">
        <header className="space-y-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-400/90">
            {t('topidle.eyebrow')}
          </p>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-emerald-400/45 bg-gradient-to-br from-emerald-400/30 to-emerald-950/50 text-emerald-100 shadow-lg shadow-emerald-950/50">
              <Vote size={28} aria-hidden />
            </span>
            <div className="min-w-0 space-y-1.5">
              <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">
                {t('topidle.title')}
              </h1>
              <p className="text-sm leading-relaxed text-slate-400">{t('topidle.subtitle', hps)}</p>
            </div>
          </div>
        </header>

        <section className="relative overflow-hidden rounded-3xl border border-emerald-400/30 bg-gradient-to-br from-emerald-950/70 via-slate-950/85 to-cyan-950/40 p-5 shadow-[0_18px_50px_rgba(6,78,59,0.35),inset_0_1px_0_rgba(52,211,153,0.18)] sm:p-6">
          <div
            className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-emerald-400/20 blur-3xl"
            aria-hidden
          />
          <div className="relative flex items-start justify-between gap-3">
            <p className="text-[11px] font-bold uppercase tracking-widest text-emerald-300/85">
              {t('topidle.rewardLabel')}
            </p>
            <span
              className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ${
                waiting
                  ? 'border-amber-400/40 bg-amber-500/15 text-amber-200'
                  : 'border-emerald-300/40 bg-emerald-400/15 text-emerald-200'
              }`}
            >
              {waiting ? t('topidle.waitingBadge') : t('topidle.readyBadge')}
            </span>
          </div>
          <div className="relative mt-3 flex items-end gap-3">
            <p className="font-mono text-6xl font-black leading-none tracking-tight text-white drop-shadow-[0_0_24px_rgba(52,211,153,0.35)] sm:text-7xl">
              +{HPS_LABEL}
            </p>
            <p className="mb-1.5 text-lg font-black uppercase tracking-[0.18em] text-emerald-300">
              {t('topidle.rewardUnit')}
            </p>
          </div>
          <p className="relative mt-3 text-sm text-slate-300">{t('topidle.rewardPerVote', hps)}</p>
          {waiting && nextMs != null ? (
            <p className="relative mt-3 inline-flex items-center gap-2 rounded-xl border border-amber-400/25 bg-amber-950/40 px-3 py-2 text-sm font-semibold text-amber-100">
              <Timer size={16} aria-hidden />
              {t('topidle.nextVote', { time: formatCheckinCountdown(nextMs) })}
            </p>
          ) : (
            <p className="relative mt-3 text-sm font-semibold text-emerald-200/90">{t('topidle.ready')}</p>
          )}
        </section>

        <a
          href={voteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group relative w-full overflow-hidden rounded-2xl border border-emerald-300/60 bg-gradient-to-b from-emerald-400 to-emerald-700 px-4 py-4 text-center text-base font-black tracking-wide text-emerald-950 shadow-[0_12px_40px_rgba(16,185,129,0.32)] transition duration-200 hover:from-emerald-300 hover:to-emerald-600 active:scale-[0.98]"
        >
          <span
            className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full"
            aria-hidden
          />
          <span className="relative inline-flex items-center justify-center gap-2">
            <ExternalLink size={18} aria-hidden />
            {t('topidle.voteCta')}
          </span>
        </a>
        <p className="text-center text-[11px] font-medium uppercase tracking-wider text-slate-500">
          {t('topidle.opensNewTab')}
        </p>

        <section className="space-y-3 rounded-2xl border border-slate-700/70 bg-slate-950/70 p-4 backdrop-blur-sm">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              {t('topidle.historyTitle')}
            </p>
            {status && status.voteCount > 0 ? (
              <p className="text-[11px] font-semibold text-emerald-300/90">
                {t('topidle.historyTotal', {
                  hps: String(status.totalHps),
                  count: String(status.voteCount)
                })}
              </p>
            ) : null}
          </div>
          {!status || status.history.length === 0 ? (
            <p className="text-sm text-slate-400">{t('topidle.historyEmpty')}</p>
          ) : (
            <ul className="divide-y divide-slate-800/80">
              {status.history.map((row) => (
                <li key={row.eventId} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <p className="min-w-0 text-sm text-slate-300">
                    {formatInstantMs(row.votedAtMs, locale)}
                  </p>
                  <p className="shrink-0 font-mono text-sm font-bold text-emerald-300">
                    {t('topidle.historyItem', { hps: String(row.hpsGranted) })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3 rounded-2xl border border-slate-700/70 bg-slate-950/70 p-4 backdrop-blur-sm">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            {t('topidle.howTitle')}
          </p>
          <ol className="space-y-3">
            {(
              [
                { icon: <ExternalLink size={16} aria-hidden />, text: t('topidle.stepVote') },
                { icon: <Mail size={16} aria-hidden />, text: t('topidle.stepEmail') },
                { icon: <Zap size={16} aria-hidden />, text: t('topidle.stepCredit', hps) }
              ] as const
            ).map((step, index) => (
              <HowStep key={step.text} n={index + 1} icon={step.icon} text={step.text} />
            ))}
          </ol>
        </section>

        <p className="text-center text-xs leading-relaxed text-slate-500">{t('topidle.rewardHint', hps)}</p>
      </div>
    </div>
  );
}

function HowStep({ n, icon, text }: { n: number; icon: ReactNode; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300">
        {icon}
      </span>
      <p className="min-w-0 pt-1 text-sm leading-snug text-slate-200">
        <span className="mr-1.5 font-mono text-[11px] font-bold text-emerald-400/80">{n}.</span>
        {text}
      </p>
    </li>
  );
}
