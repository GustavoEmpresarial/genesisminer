// @ts-nocheck — markup legado; o client usa strict+noUnusedLocals.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  Loader2,
  ChevronLeft,
  ChevronRight,
  History,
  Package,
  Activity,
  AlertTriangle,
  Search
} from 'lucide-react';
import type { GameUserActivityEntry } from '../lib/adminTypes';
import {
  getAdminUserActivity,
  getAdminUserInventoryAudit,
  getAdminUserSessionSnapshots,
  type AdminInventoryAuditRow,
  type AdminSessionSnapshotEntry
} from '../../../shared/api/admin-users';
import { formatAccountCreatedBrt } from '../utils/adminUserActivityLog';
import {
  ACTIVITY_LOG_FILTER_GROUPS,
  filterUserActivityLogs,
  formatActivityEvent,
  type ActivityEventDisplay
} from '../utils/activityEventFormatter';
import { formatActivityLogBrt, AdminActivityLogTable } from './AdminActivityLogTable';
import { AdminUserAccountTracePanel } from './AdminUserAccountTracePanel';

type AuditSubTab = 'activity' | 'inventory' | 'state' | 'trace';

export type AdminUserAuditPanelProps = {
  userId: number | null;
  userEmail: string;
};

export const AdminUserAuditPanel: React.FC<AdminUserAuditPanelProps> = ({ userId, userEmail }) => {
  const [auditSubTab, setAuditSubTab] = useState<AuditSubTab>('activity');

  const [activityLogs, setActivityLogs] = useState<GameUserActivityEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityMongoNote, setActivityMongoNote] = useState<string | null>(null);
  const [accountCreatedAtMs, setAccountCreatedAtMs] = useState<number | null>(null);
  const [activityFilterId, setActivityFilterId] = useState('all');
  const [activitySearch, setActivitySearch] = useState('');
  const [hasMoreActivity, setHasMoreActivity] = useState(false);
  const [expandedTech, setExpandedTech] = useState<Record<string, boolean>>({});

  const [inventoryRows, setInventoryRows] = useState<AdminInventoryAuditRow[]>([]);
  const [inventoryTotal, setInventoryTotal] = useState(0);
  const [inventoryPage, setInventoryPage] = useState(1);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryLossesOnly, setInventoryLossesOnly] = useState(false);

  const [snapshots, setSnapshots] = useState<AdminSessionSnapshotEntry[]>([]);
  const [snapshotDiffs, setSnapshotDiffs] = useState<
    Array<{
      snapshotId: string;
      createdAt: number;
      fingerprintChanged: boolean;
      inventoryDiff: Array<{ itemId: string; before: number; after: number; delta: number }>;
    }>
  >([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);

  const loadActivity = useCallback(
    async (beforeMs?: number) => {
      if (!userId && !userEmail.trim()) return;
      setActivityLoading(true);
      setActivityError(null);
      try {
        const res = await getAdminUserActivity(userEmail, {
          userId: userId ?? undefined,
          limit: 100,
          beforeMs,
          filterId: activityFilterId !== 'all' ? activityFilterId : undefined,
          search: activitySearch.trim() || undefined
        });
        if (res.error) {
          setActivityError(res.error);
          if (!beforeMs) setActivityLogs([]);
        } else {
          setActivityMongoNote(res.activityLogNote ?? null);
          setAccountCreatedAtMs(res.accountCreatedAtMs ?? null);
          setHasMoreActivity(!!res.hasMore);
          if (beforeMs) {
            setActivityLogs((prev) => [...prev, ...res.logs]);
          } else {
            setActivityLogs(res.logs);
          }
        }
      } finally {
        setActivityLoading(false);
      }
    },
    [userEmail, userId, activityFilterId, activitySearch]
  );

  const loadInventory = useCallback(
    async (page: number) => {
      if (!userId) return;
      setInventoryLoading(true);
      try {
        const res = await getAdminUserInventoryAudit(userId, {
          page,
          limit: 50,
          lossesOnly: inventoryLossesOnly
        });
        if (res) {
          setInventoryRows(res.rows);
          setInventoryTotal(res.total);
          setInventoryPage(res.page);
        }
      } finally {
        setInventoryLoading(false);
      }
    },
    [userId, inventoryLossesOnly]
  );

  const loadSnapshots = useCallback(async () => {
    if (!userId) return;
    setSnapshotsLoading(true);
    try {
      const res = await getAdminUserSessionSnapshots(userId, 20);
      if (res) {
        setSnapshots(res.snapshots);
        setSnapshotDiffs(res.diffs);
      }
    } finally {
      setSnapshotsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (auditSubTab === 'activity') void loadActivity();
  }, [auditSubTab, loadActivity]);

  useEffect(() => {
    if (auditSubTab === 'inventory') void loadInventory(1);
  }, [auditSubTab, loadInventory]);

  useEffect(() => {
    if (auditSubTab === 'state') void loadSnapshots();
  }, [auditSubTab, loadSnapshots]);

  const filteredActivity = useMemo(
    () =>
      filterUserActivityLogs(activityLogs, activityFilterId, activitySearch, {
        accountCreatedAtMs
      }),
    [activityLogs, activityFilterId, activitySearch, accountCreatedAtMs]
  );

  const inventoryPages = Math.max(1, Math.ceil(inventoryTotal / 50));

  const displayFor = (row: GameUserActivityEntry): ActivityEventDisplay =>
    row.display ?? formatActivityEvent(row.action, row.meta);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2 border-b border-slate-700 pb-2">
        <button
          type="button"
          onClick={() => setAuditSubTab('activity')}
          className={`px-3 py-1.5 text-xs font-bold rounded flex items-center gap-1.5 ${
            auditSubTab === 'activity' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400'
          }`}
        >
          <Activity size={14} />
          Atividade
        </button>
        <button
          type="button"
          onClick={() => setAuditSubTab('inventory')}
          className={`px-3 py-1.5 text-xs font-bold rounded flex items-center gap-1.5 ${
            auditSubTab === 'inventory' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400'
          }`}
        >
          <Package size={14} />
          Inventário
        </button>
        <button
          type="button"
          onClick={() => setAuditSubTab('state')}
          className={`px-3 py-1.5 text-xs font-bold rounded flex items-center gap-1.5 ${
            auditSubTab === 'state' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400'
          }`}
        >
          <History size={14} />
          Estado (login)
        </button>
        <button
          type="button"
          onClick={() => setAuditSubTab('trace')}
          className={`px-3 py-1.5 text-xs font-bold rounded flex items-center gap-1.5 ${
            auditSubTab === 'trace' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400'
          }`}
        >
          <Search size={14} />
          Rastreio
        </button>
        <button
          type="button"
          onClick={() => {
            if (auditSubTab === 'activity') void loadActivity();
            if (auditSubTab === 'inventory') void loadInventory(inventoryPage);
            if (auditSubTab === 'state') void loadSnapshots();
          }}
          className="ml-auto px-2 py-1.5 text-xs text-slate-400 hover:text-white flex items-center gap-1"
        >
          <RefreshCw size={12} />
          Recarregar
        </button>
      </div>

      <p className="text-[11px] text-slate-500">
        Auditoria para <span className="font-mono text-slate-300">{userEmail}</span>
        {userId != null ? <span className="text-slate-600"> (user #{userId})</span> : null}
        — textos em português; horários em Brasília.
      </p>

      {formatAccountCreatedBrt(accountCreatedAtMs) && auditSubTab === 'activity' && (
        <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 px-3 py-2 text-[11px] text-emerald-100/95">
          <span className="font-bold text-emerald-400/95">Conta criada (estimativa): </span>
          {formatAccountCreatedBrt(accountCreatedAtMs)}
        </div>
      )}

      {auditSubTab === 'activity' && (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
            <select
              value={activityFilterId}
              onChange={(e) => setActivityFilterId(e.target.value)}
              className="rounded border border-slate-600 bg-slate-900 px-2 py-1.5 text-xs text-white"
            >
              {ACTIVITY_LOG_FILTER_GROUPS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
            <input
              type="search"
              value={activitySearch}
              onChange={(e) => setActivitySearch(e.target.value)}
              placeholder="Pesquisar no resumo legível…"
              className="flex-1 min-w-[12rem] rounded border border-slate-600 bg-slate-900 px-2 py-1.5 text-xs text-white"
            />
            <button
              type="button"
              onClick={() => void loadActivity()}
              className="px-3 py-1.5 text-xs font-bold rounded bg-amber-600/30 border border-amber-600/50 text-amber-100"
            >
              Aplicar filtros
            </button>
          </div>

          {activityMongoNote && (
            <div className="rounded-lg border border-sky-800/60 bg-sky-950/40 px-3 py-2 text-xs text-sky-100">
              {activityMongoNote}
            </div>
          )}
          {activityError && (
            <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
              {activityError}
            </div>
          )}

          <AdminActivityLogTable
            rows={filteredActivity}
            loading={activityLoading}
            emptyMessage="Nenhum evento."
            expandedTech={expandedTech}
            setExpandedTech={setExpandedTech}
            displayFor={displayFor}
          />

          {hasMoreActivity && (
            <button
              type="button"
              disabled={activityLoading}
              onClick={() => {
                const last = activityLogs[activityLogs.length - 1];
                if (last) void loadActivity(last.createdAt);
              }}
              className="w-full py-2 text-xs font-bold rounded border border-slate-700 text-slate-400 hover:text-white"
            >
              Carregar mais antigos
            </button>
          )}
        </>
      )}

      {auditSubTab === 'inventory' && (
        <>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={inventoryLossesOnly}
              onChange={(e) => setInventoryLossesOnly(e.target.checked)}
            />
            <AlertTriangle size={14} className="text-amber-500" />
            Só perdas de quantidade
          </label>
          {inventoryLoading ? (
            <Loader2 className="animate-spin mx-auto text-slate-500" />
          ) : (
            <>
              <div className="rounded-lg border border-slate-700 overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-950 text-slate-500 uppercase text-[10px] font-bold">
                    <tr>
                      <th className="px-2 py-2">Data</th>
                      <th className="px-2 py-2">Item</th>
                      <th className="px-2 py-2">Antes → Depois</th>
                      <th className="px-2 py-2">Δ</th>
                      <th className="px-2 py-2">Origem</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {inventoryRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-slate-500">
                          Sem movimentos em Postgres (inventory_movements). Alterações futuras no save-game
                          passam a ser registadas.
                        </td>
                      </tr>
                    ) : (
                      inventoryRows.map((r) => (
                        <tr key={r.id} className="hover:bg-slate-800/30">
                          <td className="px-2 py-2 font-mono text-slate-500 whitespace-nowrap">
                            {formatActivityLogBrt(r.createdAtMs)}
                          </td>
                          <td className="px-2 py-2 text-white">{r.itemName || r.catalogItemId || '—'}</td>
                          <td className="px-2 py-2 font-mono">
                            {r.quantityBefore ?? '—'} → {r.quantityAfter ?? '—'}
                          </td>
                          <td
                            className={`px-2 py-2 font-mono font-bold ${
                              (r.delta ?? 0) < 0 ? 'text-red-400' : (r.delta ?? 0) > 0 ? 'text-emerald-400' : ''
                            }`}
                          >
                            {r.delta != null ? (r.delta > 0 ? `+${r.delta}` : r.delta) : '—'}
                          </td>
                          <td className="px-2 py-2 text-slate-500">{r.source}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-between items-center text-xs text-slate-500">
                <span>
                  {inventoryTotal} movimento(s) · página {inventoryPage}/{inventoryPages}
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    disabled={inventoryPage <= 1}
                    onClick={() => void loadInventory(inventoryPage - 1)}
                    className="p-1 border border-slate-700 rounded disabled:opacity-40"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    type="button"
                    disabled={inventoryPage >= inventoryPages}
                    onClick={() => void loadInventory(inventoryPage + 1)}
                    className="p-1 border border-slate-700 rounded disabled:opacity-40"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {auditSubTab === 'state' && (
        <>
          {snapshotsLoading ? (
            <Loader2 className="animate-spin mx-auto text-slate-500" />
          ) : snapshots.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-6">
              Nenhum snapshot de sessão. Aparece após o próximo login com MongoDB activo.
            </p>
          ) : (
            <div className="space-y-3">
              {snapshots.map((s, idx) => {
                const diff = snapshotDiffs.find((d) => d.snapshotId === s.id);
                const disp = s.display ?? formatActivityEvent(s.action, s.snapshot);
                return (
                  <div key={s.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                    <div className="flex justify-between gap-2">
                      <div className="font-bold text-white">{disp.title}</div>
                      <span className="text-[10px] font-mono text-slate-500">{formatActivityLogBrt(s.createdAt)}</span>
                    </div>
                    <p className="text-sm text-slate-300 mt-2">{disp.summary}</p>
                    {diff?.fingerprintChanged && idx < snapshots.length - 1 && (
                      <p className="text-[10px] text-amber-500/90 mt-1">
                        Estado diferente do login anterior
                      </p>
                    )}
                    {diff && diff.inventoryDiff.length > 0 && (
                      <div className="mt-3 border-t border-slate-800 pt-2">
                        <div className="text-[10px] uppercase text-slate-500 font-bold mb-1">
                          Diff inventário vs snapshot anterior
                        </div>
                        <ul className="text-xs text-slate-400 space-y-0.5">
                          {diff.inventoryDiff.slice(0, 15).map((it) => (
                            <li key={it.itemId}>
                              <span className="font-mono text-slate-300">{it.itemId}</span>: {it.before} →{' '}
                              {it.after}{' '}
                              <span className={it.delta < 0 ? 'text-red-400' : 'text-emerald-400'}>
                                ({it.delta > 0 ? '+' : ''}
                                {it.delta})
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {auditSubTab === 'trace' && <AdminUserAccountTracePanel userId={userId} />}
    </div>
  );
};
