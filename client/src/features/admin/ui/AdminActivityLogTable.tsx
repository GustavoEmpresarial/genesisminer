import React from 'react';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import type { GameUserActivityEntry } from '../lib/adminTypes';
import { formatActivityEvent, type ActivityEventDisplay } from '../utils/activityEventFormatter';

const SEVERITY_DOT: Record<string, string> = {
  info: 'bg-slate-400',
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  danger: 'bg-red-400'
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
    <div className="rounded-lg border border-slate-700 overflow-hidden">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-950 text-slate-500 uppercase text-[10px] font-bold">
          <tr>
            <th className="px-2 py-2 w-8" />
            <th className="px-2 py-2">Data (BRT)</th>
            <th className="px-2 py-2">Evento</th>
            <th className="px-2 py-2">Resumo</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-slate-500 italic">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const d = displayFor(row);
              return (
                <React.Fragment key={row.id}>
                  <tr className="hover:bg-slate-800/40 align-top">
                    <td className="px-2 py-2">
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${SEVERITY_DOT[d.severity] || SEVERITY_DOT.info}`}
                        title={d.severity}
                      />
                    </td>
                    <td className="px-2 py-2 text-[10px] text-slate-400 whitespace-nowrap font-mono">
                      {formatActivityLogBrt(row.createdAt)}
                    </td>
                    <td className="px-2 py-2">
                      <div className="font-bold text-slate-200">{d.title}</div>
                      <div className="text-[9px] text-slate-500 mt-0.5">
                        <span className="rounded bg-slate-800 px-1">
                          {CATEGORY_LABEL[d.category] || d.category}
                        </span>
                        <span className="ml-1 font-mono text-slate-600" title="código técnico">
                          {row.action}
                        </span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-slate-300">
                      <div>{d.summary}</div>
                      {d.lines?.map((line, i) => (
                        <div key={i} className="text-[10px] text-slate-500 mt-0.5">
                          · {line}
                        </div>
                      ))}
                      <button
                        type="button"
                        className="mt-1 text-[9px] text-slate-600 hover:text-slate-400 flex items-center gap-0.5"
                        onClick={() => setExpandedTech((p) => ({ ...p, [row.id]: !p[row.id] }))}
                      >
                        {expandedTech[row.id] ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                        JSON técnico
                      </button>
                    </td>
                  </tr>
                  {expandedTech[row.id] && (
                    <tr className="bg-slate-950/80">
                      <td colSpan={4} className="px-3 py-2 font-mono text-[10px] text-slate-500 break-all">
                        {JSON.stringify(row.meta ?? {}, null, 2)}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
};
