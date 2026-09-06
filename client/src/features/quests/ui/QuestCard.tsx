/**
 * Quest card — layout/CSS aligned with legacy `QuestsPage` QuestCard.
 */
import { CheckCircle2, Gift, Loader2, Sparkles } from 'lucide-react';
import type { QuestStateItem } from '../../../shared/api/quests';
import type { AppLocale } from '../../../shared/i18n';
import { formatUsdcAmount } from '../../../shared/utils/locale-format';
import { questActionLabel } from '../lib/questActionMeta';

type QuestCardProps = {
  item: QuestStateItem;
  claimingId: string | null;
  onClaim: (id: string) => void;
  t: (key: string) => string;
  locale: AppLocale;
};

export function QuestCard({ item, claimingId, onClaim, t, locale }: QuestCardProps) {
  const pct = Math.min(100, Math.round((item.progress / Math.max(1, item.targetCount)) * 100));
  const busy = claimingId === item.id;

  return (
    <article className="space-y-3 rounded-xl border border-slate-700/80 bg-slate-950/70 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-widest text-amber-400/90">
            {questActionLabel(item.actionType, t)}
          </div>
          <h3 className="mt-0.5 text-sm font-black leading-snug text-white sm:text-base">{item.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">{item.description}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="inline-flex items-center gap-1 rounded-full border border-emerald-600/50 bg-emerald-950/40 px-2 py-1 text-[11px] font-bold text-emerald-300">
            <Gift size={12} />
            {formatUsdcAmount(item.rewardUsdc, locale)}
          </div>
        </div>
      </div>

      <div>
        <div className="mb-1 flex justify-between font-mono text-[11px] text-slate-400">
          <span>
            {item.progress}/{item.targetCount}
          </span>
          <span>{pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-800">
          <div
            className={`h-full rounded-full transition-all ${
              item.claimed ? 'bg-slate-500' : item.completed ? 'bg-emerald-500' : 'bg-amber-500'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        {item.claimed ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-400">
            <CheckCircle2 size={14} className="text-emerald-500" />
            {t('quests.claimed')}
          </span>
        ) : item.canClaim ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onClaim(item.id)}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-xs font-black uppercase tracking-wide text-white transition hover:bg-amber-500 disabled:opacity-60"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {t('quests.claim')}
          </button>
        ) : (
          <span className="text-xs font-medium text-slate-500">
            {item.completed ? t('quests.readyToClaim') : t('quests.inProgress')}
          </span>
        )}
      </div>
    </article>
  );
}
