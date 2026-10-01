import React from 'react';
import { Loader2 } from 'lucide-react';
import type { GameUserActivityEntry } from '../lib/adminTypes';
import { formatActivityEvent, type ActivityEventDisplay } from '../utils/activityEventFormatter';

const SEVERITY_BORDER: Record<string, string> = {
  info: 'border-l-slate-500',
  success: 'border-l-emerald-500',
  warning: 'border-l-amber-500',
  danger: 'border-l-red-500'
};

const CATEGORY_LABEL: Record<string, string> = {
  auth: 'Conta',
  inventory: 'Inventário',
  rigs: 'Rigs',
  economy: 'Economia',
  boxes: 'Caixas',
  session: 'Sessão',
  p2p: 'P2P',
  other: 'Outro'
};

export function formatActivityLogBrt(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'medium',
      timeZone: 'America/Sao_Paulo'
    }).format(new Date(ms));
  } catch {
    return '—';
  }
}

export type AdminActivityLogTableProps = {
  rows: GameUserActivityEntry[];
  loading?: boolean;
  emptyMessage?: string;
  expandedTech: Record<string, boolean>;
  setExpandedTech: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  displayFor?: (row: GameUserActivityEntry) => ActivityEventDisplay;
};

export const AdminActivityLogTable: React.FC<AdminActivityLogTableProps> = ({
  rows,
  loading = false,
  emptyMessage = 'Nenhum evento.',
  expandedTech,
  setExpandedTech,
  displayFor = (row) => row.display ?? formatActivityEvent(row.action, row.meta)
}) => {
  if (loading && rows.length === 0) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="rounded-xl border border-slate-700 px-4 py-10 text-center text-sm text-slate-400">{emptyMessage}</p>
      ) : (
        rows.map((row) => {
          const d = displayFor(row);
          const category = CATEGORY_LABEL[d.category] || 'Outro';
          return (
            <article
              key={row.id}
              className={`rounded-xl border border-slate-700 border-l-4 bg-slate-900/70 p-4 ${SEVERITY_BORDER[d.severity] || SEVERITY_BORDER.info}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-slate-400">{formatActivityLogBrt(row.createdAt)}</p>
                  <h3 className="mt-1 text-base font-bold text-white">{d.title}</h3>
                </div>
                <span className="shrink-0 rounded-full bg-slate-800 px-3 py-1 text-xs font-bold uppercase tracking-wide text-slate-200">
                  {category}
                </span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-100">{d.summary}</p>
              {d.lines && d.lines.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm text-slate-300">
                  {d.lines.map((line, i) => (
                    <li key={`${row.id}-${i}`}>{line}</li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="mt-3 text-sm text-slate-500 hover:text-slate-300"
                onClick={() => setExpandedTech((p) => ({ ...p, [row.id]: !p[row.id] }))}
              >
                {expandedTech[row.id] ? 'Ocultar dados técnicos' : 'Dados técnicos'}
              </button>
              {expandedTech[row.id] && (
                <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-400">
                  {JSON.stringify(row.meta ?? {}, null, 2)}
                </pre>
              )}
            </article>
          );
        })
      )}
    </div>
  );
};
