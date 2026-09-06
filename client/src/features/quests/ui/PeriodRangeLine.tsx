/**
 * Daily / weekly window line — matches legacy QuestsPage `PeriodRangeLine`.
 */
import type { AppLocale } from '../../../shared/i18n';
import { formatQuestPeriodInstant } from '../lib/formatQuestPeriodInstant';

type PeriodRangeLineProps = {
  label: string;
  startMs: number;
  endMs: number;
  timeZone: string;
  zoneLabel: string;
  locale: AppLocale;
  startWord: string;
  endWord: string;
};

export function PeriodRangeLine({
  label,
  startMs,
  endMs,
  timeZone,
  zoneLabel,
  locale,
  startWord,
  endWord
}: PeriodRangeLineProps) {
  return (
    <div className="rounded-lg border border-slate-700/70 bg-slate-950/50 px-3 py-2 text-[11px] leading-relaxed text-slate-300 sm:text-xs">
      <span className="font-black uppercase tracking-wide text-amber-300/90">{label}</span>
      <span className="text-slate-500"> · </span>
      <span>
        {startWord}{' '}
        <span className="font-mono text-slate-100">
          {formatQuestPeriodInstant(startMs, timeZone, zoneLabel, locale)}
        </span>
      </span>
      <span className="text-slate-500"> → </span>
      <span>
        {endWord}{' '}
        <span className="font-mono text-slate-100">
          {formatQuestPeriodInstant(endMs, timeZone, zoneLabel, locale)}
        </span>
      </span>
    </div>
  );
}
