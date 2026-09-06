/**
 * Player quests (daily / weekly) — Hub view.
 * Layout/CSS aligned with `legacy/frontend/components/QuestsPage.tsx`.
 * API: `shared/api/quests.ts` · DECISIONS #95.
 */
import { useCallback, useEffect, useState } from 'react';
import { ListChecks, RefreshCw, Trophy, TrendingUp } from 'lucide-react';
import {
  claimQuestReward,
  getMyGlobalRanking,
  getQuestsState,
  type QuestsStatePayload
} from '../../../shared/api/quests';
import { mapApiErrorToMessage } from '../../../shared/api/client-errors';
import { useI18n, useT } from '../../../shared/i18n';
import { dateLocaleFor, formatUsdcAmount } from '../../../shared/utils/locale-format';
import { QuestCard } from './QuestCard';
import { PeriodRangeLine } from './PeriodRangeLine';
import { QuestSectionTitle } from './QuestSectionTitle';

const BRT_TZ = 'America/Sao_Paulo';
const BRT_LABEL = 'BRT';

type QuestsPageProps = {
  onGoToRanking?: () => void;
  onUsdcChange?: (usdc: number) => void;
};

export function QuestsPage({ onGoToRanking, onUsdcChange }: QuestsPageProps) {
  const t = useT();
  const { locale } = useI18n();
  const [state, setState] = useState<QuestsStatePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [toastTone, setToastTone] = useState<'ok' | 'err'>('ok');
  const [rankPosition, setRankPosition] = useState<number | null>(null);
  const [rankTotal, setRankTotal] = useState(0);

  const loadRank = useCallback(async () => {
    const res = await getMyGlobalRanking();
    if (res.ok) {
      setRankPosition(res.position);
      setRankTotal(res.totalRanked);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    const [{ data, error }] = await Promise.all([getQuestsState(), loadRank()]);
    if (data) setState(data);
    if (error) setErrorMsg(mapApiErrorToMessage(error, t, 'quests'));
    setLoading(false);
  }, [loadRank, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const onClaim = async (questId: string) => {
    setClaimingId(questId);
    setToast(null);
    const { data, error } = await claimQuestReward(questId);
    setClaimingId(null);
    if (error) {
      setToastTone('err');
      setToast(mapApiErrorToMessage(error, t, 'quests'));
      return;
    }
    if (data) {
      setToastTone('ok');
      setToast(t('quests.claimSuccess', { amount: formatUsdcAmount(data.rewardUsdc, locale) }));
      onUsdcChange?.(data.newUsdc);
      await load();
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-3 pb-10 pt-4 text-slate-100 sm:px-4 sm:pt-5 lg:pt-6">
      <div className="space-y-2 rounded-2xl border border-amber-500/30 bg-gradient-to-br from-slate-900 via-slate-950 to-amber-950/20 px-4 py-5 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-amber-600/90 text-white shadow-lg shadow-amber-900/30">
              <ListChecks size={22} />
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-widest text-amber-400/90">
                {t('quests.eyebrow')}
              </div>
              <h1 className="truncate text-xl font-black tracking-tight sm:text-3xl">{t('quests.title')}</h1>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg p-2 text-slate-400 hover:bg-amber-500/10 hover:text-amber-300"
            title={t('quests.refresh')}
            aria-label={t('quests.refresh')}
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <p className="text-xs leading-relaxed text-slate-400 sm:text-sm">{t('quests.subtitle')}</p>
        {(state?.dailyPeriod || state?.weeklyPeriod) && (
          <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
            {state.dailyPeriod ? (
              <PeriodRangeLine
                label={t('quests.daily')}
                startMs={state.dailyPeriod.startMs}
                endMs={state.dailyPeriod.endMs}
                timeZone={BRT_TZ}
                zoneLabel={BRT_LABEL}
                locale={locale}
                startWord={t('quests.periodStart')}
                endWord={t('quests.periodEnd')}
              />
            ) : null}
            {state.weeklyPeriod ? (
              <PeriodRangeLine
                label={t('quests.weekly')}
                startMs={state.weeklyPeriod.startMs}
                endMs={state.weeklyPeriod.endMs}
                timeZone={BRT_TZ}
                zoneLabel={BRT_LABEL}
                locale={locale}
                startWord={t('quests.periodStart')}
                endWord={t('quests.periodEnd')}
              />
            ) : null}
          </div>
        )}
        {toast ? (
          <p className={`text-xs font-bold ${toastTone === 'err' ? 'text-red-400' : 'text-emerald-400'}`}>{toast}</p>
        ) : null}
        {errorMsg ? <p className="text-xs font-bold text-red-400">{errorMsg}</p> : null}
      </div>

      <section className="space-y-3">
        <QuestSectionTitle tone="yellow">
          <TrendingUp size={16} /> {t('quests.climbRank')}
        </QuestSectionTitle>
        <div className="flex flex-col gap-4 rounded-xl border border-yellow-500/35 bg-gradient-to-br from-yellow-950/40 via-slate-950 to-slate-950 p-4 sm:flex-row sm:items-center sm:p-5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-yellow-400/40 bg-yellow-500/20 text-yellow-300">
              <Trophy size={22} />
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-widest text-yellow-400/90">
                {t('quests.globalRank')}
              </div>
              <div className="font-mono text-2xl font-black tracking-tight text-white sm:text-3xl">
                {rankPosition != null ? `#${rankPosition}` : '—'}
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                {rankPosition != null && rankTotal > 0
                  ? t('quests.rankAmong', {
                      total: rankTotal.toLocaleString(dateLocaleFor(locale))
                    })
                  : t('quests.rankHint')}
              </p>
            </div>
          </div>
          {onGoToRanking ? (
            <button
              type="button"
              onClick={onGoToRanking}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-yellow-500 px-4 py-2.5 text-xs font-black uppercase tracking-wide text-stone-950 transition hover:bg-yellow-400"
            >
              <Trophy size={14} />
              {t('quests.viewLeaderboard')}
            </button>
          ) : null}
        </div>
      </section>

      {loading && !state ? (
        <p className="py-10 text-center text-sm text-slate-500">{t('quests.loading')}</p>
      ) : (
        <>
          <section className="space-y-3">
            <QuestSectionTitle tone="amber">{t('quests.dailySection')}</QuestSectionTitle>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(state?.daily || []).map((q) => (
                <QuestCard
                  key={q.id}
                  item={q}
                  claimingId={claimingId}
                  onClaim={onClaim}
                  t={t}
                  locale={locale}
                />
              ))}
            </div>
            {(state?.daily || []).length === 0 ? (
              <p className="text-xs text-slate-500">{t('quests.emptyDaily')}</p>
            ) : null}
          </section>

          <section className="space-y-3">
            <QuestSectionTitle tone="sky">{t('quests.weeklySection')}</QuestSectionTitle>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(state?.weekly || []).map((q) => (
                <QuestCard
                  key={q.id}
                  item={q}
                  claimingId={claimingId}
                  onClaim={onClaim}
                  t={t}
                  locale={locale}
                />
              ))}
            </div>
            {(state?.weekly || []).length === 0 ? (
              <p className="text-xs text-slate-500">{t('quests.emptyWeekly')}</p>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
