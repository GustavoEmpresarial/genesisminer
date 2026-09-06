// @ts-nocheck — markup legado; o client usa strict+noUnusedLocals.
import React, { Fragment, useCallback, useEffect, useState } from 'react';
import {
  bulkDeleteUsers,
  getAdminSuspiciousEmails,
  getAdminSuspiciousEmailsExportUrl,
  getAdminUserActivity,
  postAdminDeactivateFilteredSuspiciousUsers,
  toggleUserBlocked,
  type AdminSuspiciousEmailsReport,
  type AdminSuspiciousEmailUserRow,
} from '../../../shared/api/admin-users';
import { UiNoticeModal, type UiNotice } from '../../../shared/ui/UiNoticeModal';
import {
  Loader2,
  RefreshCw,
  Download,
  UserCircle,
  Copy,
  Hash,
  AtSign,
  ChevronDown,
  ChevronRight,
  Activity,
  Users,
  Trash2,
  Lock,
  X,
} from 'lucide-react';
import { apiFetch } from '../../../shared/api/http';

const REASON_LABEL: Record<string, string> = {
  domain_not_trusted: 'Domínio fora da lista confiável',
  invalid_format: 'Formato inválido',
  temporary_domain: 'Email temporário',
  fake_pattern: 'Padrão fake',
  duplicate_email: 'Email duplicado',
  unverified_email: 'Não verificado',
  suspicious_domain: 'Domínio suspeito',
  never_mined: 'Nunca minerou',
  zero_hash: 'Hash zero',
  no_wallet: 'Sem carteira',
  no_deposit: 'Sem depósito',
  referral_only: 'Entrou por indicação e não teve actividade real.',
  inactive_account: 'Conta inativa',
  no_game_progress: 'Sem progresso',
  dead_account: 'Conta morta',
};

function badgeClass(code: string): string {
  switch (code) {
    case 'invalid_format':
      return 'bg-red-900/50 text-red-200 border-red-700/60';
    case 'temporary_domain':
      return 'bg-orange-900/40 text-orange-200 border-orange-700/50';
    case 'fake_pattern':
      return 'bg-amber-900/40 text-amber-200 border-amber-700/50';
    case 'duplicate_email':
      return 'bg-purple-900/40 text-purple-200 border-purple-700/50';
    case 'unverified_email':
      return 'bg-slate-700 text-slate-200 border-slate-600';
    case 'suspicious_domain':
    case 'domain_not_trusted':
      return 'bg-yellow-900/30 text-yellow-100 border-yellow-700/40';
    case 'referral_only':
      return 'bg-cyan-900/40 text-cyan-100 border-cyan-700/50';
    case 'dead_account':
    case 'never_mined':
    case 'zero_hash':
    case 'no_game_progress':
      return 'bg-slate-800 text-slate-200 border-slate-600';
    case 'no_wallet':
    case 'no_deposit':
      return 'bg-slate-700/80 text-slate-300 border-slate-600';
    case 'inactive_account':
      return 'bg-zinc-800 text-zinc-300 border-zinc-600';
    default:
      return 'bg-slate-800 text-slate-300 border-slate-600';
  }
}

function riskBadge(level: string): { label: string; className: string } {
  switch (level) {
    case 'high':
      return { label: 'Alto', className: 'bg-red-600/90 text-white border-red-500' };
    case 'medium':
      return { label: 'Médio', className: 'bg-amber-600/90 text-white border-amber-500' };
    case 'low':
      return { label: 'Baixo', className: 'bg-sky-700/90 text-white border-sky-500' };
    default:
      return { label: 'Mínimo', className: 'bg-slate-600/90 text-slate-100 border-slate-500' };
  }
}

function formatTs(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-PT');
  } catch {
    return iso;
  }
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return n.toExponential(2);
  return n < 1 && n > 0 ? n.toFixed(6) : n.toLocaleString('pt-PT', { maximumFractionDigits: 4 });
}

type OpenUserTarget = { key: number; userId: number; email: string; username: string };

type Props = {
  requestOpenUserInEditor: (t: OpenUserTarget) => void;
};

export const AdminSuspiciousEmailsPanel: React.FC<Props> = ({ requestOpenUserInEditor }) => {
  const [notice, setNotice] = useState<UiNotice | null>(null);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<AdminSuspiciousEmailsReport | null>(null);
  const [q, setQ] = useState('');
  const [reason, setReason] = useState('all');
  const [activity, setActivity] = useState('all');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('risk_desc');
  const [specificDomain, setSpecificDomain] = useState('');
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  /** id → email para acções em massa mesmo após mudar de página */
  const [selectedById, setSelectedById] = useState<Map<number, { email: string }>>(new Map());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [activityLines, setActivityLines] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const domainParam = reason === 'specific_domain' ? specificDomain.trim().toLowerCase() : undefined;
      const data = await getAdminSuspiciousEmails({
        q: q.trim() || undefined,
        reason,
        activity,
        status,
        domain: domainParam,
        page,
        limit,
        sort,
      });
      setReport(data);
      if (data.error) {
        setNotice({ variant: 'error', title: 'Erro', message: data.error });
      }
    } catch {
      setNotice({ variant: 'error', title: 'Erro', message: 'Falha ao carregar dados.' });
    } finally {
      setLoading(false);
    }
  }, [q, reason, activity, status, sort, specificDomain, page, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const loadActivityPreview = async (row: AdminSuspiciousEmailUserRow) => {
    if (activityLines[row.id]) return;
    const res = await getAdminUserActivity(row.email, { userId: row.id, limit: 40 });
    if (res.error) {
      setActivityLines((m) => ({ ...m, [row.id]: res.error || 'Erro' }));
      return;
    }
    const preview =
      res.logs.length === 0
        ? 'Sem entradas de actividade recentes.'
        : res.logs
            .slice(0, 12)
            .map((l) => `${l.action ?? '—'} · ${typeof l.createdAt === 'string' ? l.createdAt : ''}`)
            .join('\n');
    setActivityLines((m) => ({ ...m, [row.id]: preview }));
  };

  const toggleSelect = (row: AdminSuspiciousEmailUserRow) => {
    setSelectedById((prev) => {
      const n = new Map(prev);
      if (n.has(row.id)) n.delete(row.id);
      else n.set(row.id, { email: row.email });
      return n;
    });
  };

  const toggleSelectAllOnPage = (rows: AdminSuspiciousEmailUserRow[]) => {
    const all = rows.length > 0 && rows.every((r) => selectedById.has(r.id));
    setSelectedById(() => {
      if (all) return new Map();
      const n = new Map<number, { email: string }>();
      for (const r of rows) n.set(r.id, { email: r.email });
      return n;
    });
  };

  const clearSelection = () => setSelectedById(new Map());

  const handleBulkBlock = async () => {
    if (selectedById.size === 0) return;
    const emails = Array.from(selectedById.values()).map((v) => v.email);
    if (!window.confirm(`Desactivar ${emails.length} conta(s) seleccionada(s)?`)) return;
    setBulkBusy(true);
    let ok = 0;
    const failed: string[] = [];
    for (const email of emails) {
      const r = await toggleUserBlocked(email, true);
      if (r.ok) ok += 1;
      else failed.push(email);
    }
    setBulkBusy(false);
    await load();
    if (failed.length === 0) {
      clearSelection();
      setNotice({ variant: 'success', title: 'Desactivação', message: `${ok} conta(s) desactivada(s).` });
    } else {
      const sample = failed.slice(0, 5).join(', ');
      setNotice({
        variant: 'error',
        title: 'Desactivação em massa',
        message:
          failed.length > 5
            ? `Desactivados: ${ok}. Falharam: ${failed.length} (ex.: ${sample}…).`
            : `Desactivados: ${ok}. Falharam: ${failed.length} (${sample}).`,
      });
    }
  };

  const handleDeactivateFiltered = async () => {
    const n = report?.summary?.totalActiveFiltered ?? 0;
    if (n < 1 || bulkBusy) return;
    if (
      !window.confirm(
        `Desactivar ${n} conta(s) activa(s) com os filtros actuais?\n\nNão apaga dados. Deixam de entrar no jogo e de contar no dashboard.`
      )
    ) {
      return;
    }
    setBulkBusy(true);
    const domainParam = reason === 'specific_domain' ? specificDomain.trim().toLowerCase() : undefined;
    const res = await postAdminDeactivateFilteredSuspiciousUsers({
      q: q.trim() || undefined,
      reason,
      activity,
      status,
      domain: domainParam,
      expectedCount: n,
    });
    setBulkBusy(false);
    if (!res.ok) {
      setNotice({
        variant: 'error',
        title: 'Desactivar filtrados',
        message: res.error || 'Falha ao desactivar contas.',
      });
      if (res.code === 'COUNT_MISMATCH') await load();
      return;
    }
    await load();
    clearSelection();
    setNotice({
      variant: 'success',
      title: 'Desactivação em massa',
      message: `${res.deactivated ?? n} conta(s) desactivada(s).`,
    });
  };

  const handleBulkDelete = async () => {
    if (selectedById.size === 0) return;
    const emails = Array.from(selectedById.values()).map((v) => v.email);
    if (
      !window.confirm(
        `Excluir EM MASSA ${emails.length} conta(s) seleccionada(s)? Esta ação é IRREVERSÍVEL. (Exclusão em massa: super administrador.)`
      )
    ) {
      return;
    }
    setBulkBusy(true);
    const res = await bulkDeleteUsers(emails);
    setBulkBusy(false);
    if (res.ok) {
      await load();
      clearSelection();
      setNotice({
        variant: 'success',
        title: 'Exclusão',
        message: `${res.count ?? emails.length} conta(s) excluída(s).`,
      });
    } else {
      setNotice({ variant: 'error', title: 'Exclusão em massa', message: res.error || 'Falha na exclusão.' });
    }
  };

  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ variant: 'success', title: 'Copiado', message: `${label} copiado para a área de transferência.` });
    } catch {
      setNotice({ variant: 'error', title: 'Clipboard', message: 'Não foi possível copiar (permissão do navegador?).' });
    }
  };

  const exportCsv = async () => {
    const domainParam = reason === 'specific_domain' ? specificDomain.trim().toLowerCase() : undefined;
    const url = getAdminSuspiciousEmailsExportUrl({
      q: q.trim() || undefined,
      reason,
      activity,
      status,
      domain: domainParam,
      sort,
    });
    try {
      const res = await apiFetch(url, { credentials: 'include' });
      if (!res.ok) {
        setNotice({ variant: 'error', title: 'Exportação', message: `Erro ${res.status} ao exportar.` });
        return;
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'emails-suspeitos.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      setNotice({ variant: 'success', title: 'CSV', message: 'Ficheiro transferido (até 5000 linhas com os filtros actuais).' });
    } catch {
      setNotice({ variant: 'error', title: 'Exportação', message: 'Erro de rede ao exportar.' });
    }
  };

  const s = report?.summary;
  const users = report?.users ?? [];

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 space-y-6">
      <UiNoticeModal notice={notice} onClose={() => setNotice(null)} overlayZClassName="z-[160]" />

      <div className="flex flex-col gap-2 border-b border-slate-700 pb-4">
        <div className="flex items-center gap-2">
          <AtSign className="text-amber-500 shrink-0" size={24} />
          <h3 className="text-white font-bold text-lg">Emails suspeitos</h3>
        </div>
        <p className="text-slate-400 text-sm max-w-3xl">
          Análise e sinalização para revisão manual. Nada é bloqueado nem alterado automaticamente. Domínios fora da lista
          confiável contam como suspeitos; risco agrega email + actividade na conta.
        </p>
        {report?.meta?.note && <p className="text-slate-500 text-xs">{report.meta.note}</p>}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
          <div className="text-[10px] uppercase text-slate-500 font-bold">Total filtrado</div>
          <div className="text-xl font-bold text-white mt-1">{s?.totalSuspicious ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-yellow-900/40 bg-slate-900/50 p-3">
          <div className="text-[10px] uppercase text-slate-500 font-bold">Domínio não confiável</div>
          <div className="text-xl font-bold text-yellow-100 mt-1">{s?.domainNotTrusted ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-red-900/40 bg-slate-900/50 p-3">
          <div className="text-[10px] uppercase text-slate-500 font-bold">Formato inválido</div>
          <div className="text-xl font-bold text-red-200 mt-1">{s?.invalidFormat ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-orange-900/40 bg-slate-900/50 p-3">
          <div className="text-[10px] uppercase text-slate-500 font-bold">Temporários</div>
          <div className="text-xl font-bold text-orange-200 mt-1">{s?.temporaryDomains ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-amber-900/40 bg-slate-900/50 p-3">
          <div className="text-[10px] uppercase text-slate-500 font-bold">Padrões fake</div>
          <div className="text-xl font-bold text-amber-200 mt-1">{s?.fakePatterns ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-purple-900/40 bg-slate-900/50 p-3">
          <div className="text-[10px] uppercase text-slate-500 font-bold">Duplicados</div>
          <div className="text-xl font-bold text-purple-200 mt-1">{s?.duplicates ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-slate-600 bg-slate-900/50 p-3">
          <div className="text-[10px] uppercase text-slate-500 font-bold">Não verificados</div>
          <div className="text-xl font-bold text-slate-200 mt-1">{s?.unverified ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-slate-600 bg-slate-900/50 p-3">
          <div className="text-[10px] uppercase text-slate-500 font-bold">Domínio heurístico</div>
          <div className="text-xl font-bold text-slate-200 mt-1">{s?.suspiciousDomain ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
          <div className="text-[10px] uppercase text-slate-500 font-bold">Contas mortas</div>
          <div className="text-xl font-bold text-slate-300 mt-1">{s?.deadAccounts ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-cyan-900/40 bg-slate-900/50 p-3">
          <div className="text-[10px] uppercase text-slate-500 font-bold">Referral only</div>
          <div className="text-xl font-bold text-cyan-100 mt-1">{s?.referralOnly ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-red-800/50 bg-slate-900/50 p-3">
          <div className="text-[10px] uppercase text-slate-500 font-bold">Alto risco</div>
          <div className="text-xl font-bold text-red-100 mt-1">{s?.highRisk ?? '—'}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1 min-w-[200px] flex-1">
          <label className="text-[10px] uppercase text-slate-500 font-bold">Buscar</label>
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Email, domínio, username, id ou referrer…"
            className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-amber-500 outline-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-slate-500 font-bold">Tipo</label>
          <select
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setPage(1);
            }}
            className="bg-slate-900 border border-slate-700 text-white text-xs rounded px-2 py-2 outline-none min-w-[200px]"
          >
            <option value="all">Todos suspeitos</option>
            <option value="domain_not_trusted">Domínio fora da lista confiável</option>
            <option value="invalid_format">Formato inválido</option>
            <option value="temporary_domain">Domínio temporário</option>
            <option value="fake_pattern">Padrão fake</option>
            <option value="duplicate_email">Duplicados</option>
            <option value="unverified_email">Não verificados</option>
            <option value="suspicious_domain">Domínio suspeito (heurística)</option>
            <option value="dead_account">Conta morta</option>
            <option value="referral_only">Referral only</option>
            <option value="never_mined">Nunca minerou</option>
            <option value="no_wallet">Sem carteira</option>
            <option value="no_deposit">Sem depósito</option>
            <option value="no_recent_login">Sem login recente</option>
            <option value="high_risk">Alto risco</option>
            <option value="specific_domain">Domínio específico</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-slate-500 font-bold">Actividade</label>
          <select
            value={activity}
            onChange={(e) => {
              setActivity(e.target.value);
              setPage(1);
            }}
            className="bg-slate-900 border border-slate-700 text-white text-xs rounded px-2 py-2 outline-none min-w-[180px]"
          >
            <option value="all">Todos</option>
            <option value="never_mined">Nunca minerou</option>
            <option value="no_wallet">Sem carteira</option>
            <option value="no_deposit">Sem depósito</option>
            <option value="no_recent_login">Sem login recente</option>
            <option value="referral_entry">Entrou por referral</option>
          </select>
        </div>
        {reason === 'specific_domain' && (
          <div className="flex flex-col gap-1 min-w-[160px]">
            <label className="text-[10px] uppercase text-slate-500 font-bold">Domínio</label>
            <input
              value={specificDomain}
              onChange={(e) => {
                setSpecificDomain(e.target.value);
                setPage(1);
              }}
              placeholder="ex: tempmail.com"
              className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-amber-500 outline-none"
            />
          </div>
        )}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-slate-500 font-bold">Estado</label>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="bg-slate-900 border border-slate-700 text-white text-xs rounded px-2 py-2 outline-none"
          >
            <option value="all">Todos</option>
            <option value="active">Activos</option>
            <option value="blocked">Desactivados</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-slate-500 font-bold">Ordenação</label>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(1);
            }}
            className="bg-slate-900 border border-slate-700 text-white text-xs rounded px-2 py-2 outline-none min-w-[220px]"
          >
            <option value="risk_desc">Risco (maior primeiro)</option>
            <option value="risk_asc">Risco (menor primeiro)</option>
            <option value="created_desc">Criação — mais recente</option>
            <option value="created_asc">Criação — mais antiga</option>
            <option value="domain_asc">Domínio A–Z</option>
            <option value="domain_desc">Domínio Z–A</option>
            <option value="username_asc">Username A–Z</option>
            <option value="username_desc">Username Z–A</option>
            <option value="last_login_desc">Último login</option>
            <option value="total_mined_desc">Total minerado (saldos)</option>
            <option value="total_deposited_desc">Total depositado</option>
          </select>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm font-bold disabled:opacity-50 h-[38px] self-end"
        >
          {loading ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
          Atualizar
        </button>
        <button
          type="button"
          onClick={() => void exportCsv()}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-sm font-bold h-[38px] self-end"
        >
          <Download size={16} />
          Exportar CSV
        </button>
        <button
          type="button"
          onClick={() => void handleDeactivateFiltered()}
          disabled={bulkBusy || loading || (report?.summary?.totalActiveFiltered ?? 0) < 1}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-800 hover:bg-orange-700 text-white text-sm font-bold h-[38px] self-end disabled:opacity-50"
          title="Desactiva todas as contas activas que correspondem aos filtros actuais (is_blocked=1)"
        >
          {bulkBusy ? <Loader2 className="animate-spin" size={16} /> : <Lock size={16} />}
          Desactivar filtrados activos ({report?.summary?.totalActiveFiltered ?? 0})
        </button>
      </div>

      {report?.trustedDomains && report.trustedDomains.length > 0 && (
        <details className="rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-2 text-xs text-slate-400">
          <summary className="cursor-pointer text-slate-300 font-bold select-none">Domínios confiáveis ({report.trustedDomains.length})</summary>
          <p className="mt-2 font-mono break-all">{report.trustedDomains.join(', ')}</p>
        </details>
      )}

      {report && report.domainStats && report.domainStats.length > 0 && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
          <h4 className="text-white font-bold text-sm mb-2">Domínios frequentes (≥3 na lista filtrada)</h4>
          <div className="flex flex-wrap gap-2">
            {report.domainStats.slice(0, 24).map((d) => (
              <button
                key={d.domain}
                type="button"
                onClick={() => {
                  setReason('specific_domain');
                  setSpecificDomain(d.domain);
                  setPage(1);
                }}
                className="text-xs px-2 py-1 rounded border border-slate-600 bg-slate-800 text-slate-200 hover:border-amber-600 hover:text-white"
              >
                {d.domain}{' '}
                <span className="text-amber-400 font-mono">({d.count})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedById.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-700/50 bg-slate-900/80 px-4 py-3">
          <span className="text-sm font-bold text-amber-400">{selectedById.size} seleccionado(s)</span>
          <button
            type="button"
            disabled={bulkBusy || loading}
            onClick={() => void handleBulkBlock()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-700 px-3 py-2 text-xs font-bold text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {bulkBusy ? <Loader2 className="animate-spin" size={14} /> : <Lock size={14} />}
            Desactivar seleccionados
          </button>
          <button
            type="button"
            disabled={bulkBusy || loading}
            onClick={() => void handleBulkDelete()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-950 px-3 py-2 text-xs font-bold text-red-100 ring-1 ring-red-700/60 hover:bg-red-900 disabled:opacity-50"
          >
            {bulkBusy ? <Loader2 className="animate-spin" size={14} /> : <Trash2 size={14} />}
            Excluir
          </button>
          <button
            type="button"
            disabled={bulkBusy}
            onClick={clearSelection}
            className="ml-auto inline-flex items-center gap-1 rounded p-2 text-slate-500 hover:bg-slate-800 hover:text-white"
            title="Limpar selecção"
          >
            <X size={18} />
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left min-w-[1900px] table-fixed">
          <colgroup>
            <col className="w-10" />
            <col className="w-10" />
            <col className="w-[72px]" />
            <col className="w-[88px]" />
            <col className="w-[120px]" />
            <col className="w-[140px]" />
            <col className="w-[min(420px,32vw)]" />
            <col className="w-[140px]" />
            <col className="w-[220px]" />
            <col className="w-[120px]" />
            <col className="w-[120px]" />
            <col className="w-[72px]" />
            <col className="w-[100px]" />
            <col className="w-[88px]" />
            <col className="w-[100px]" />
            <col className="w-[160px]" />
            <col className="w-[280px]" />
          </colgroup>
          <thead className="text-[10px] text-slate-500 uppercase bg-slate-900/50">
            <tr>
              <th className="px-2 py-3">
                <button
                  type="button"
                  onClick={() => toggleSelectAllOnPage(users)}
                  className="text-slate-500 hover:text-amber-400"
                  title="Seleccionar página"
                >
                  #
                </button>
              </th>
              <th className="px-1 py-3 w-8" />
              <th className="px-2 py-3">Risco</th>
              <th className="px-2 py-3">Estado</th>
              <th className="px-2 py-3">Nível</th>
              <th className="px-2 py-3">Username</th>
              <th className="px-2 py-3 text-left">Email</th>
              <th className="px-2 py-3">Domínio</th>
              <th className="px-2 py-3">Motivos</th>
              <th className="px-2 py-3">Criou</th>
              <th className="px-2 py-3">Último login</th>
              <th className="px-2 py-3">Minerou?</th>
              <th className="px-2 py-3">Hash</th>
              <th className="px-2 py-3">Carteira</th>
              <th className="px-2 py-3">Depósito</th>
              <th className="px-2 py-3">Indicado por</th>
              <th className="px-2 py-3 text-right">Acções</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {users.length === 0 && !loading && (
              <tr>
                <td colSpan={17} className="px-4 py-8 text-center text-slate-500">
                  Nenhum resultado com os filtros actuais.
                </td>
              </tr>
            )}
            {users.map((row) => {
              const rb = riskBadge(row.riskLevel);
              const ex = expanded.has(row.id);
              return (
                <Fragment key={row.id}>
                  <tr className="hover:bg-slate-900/40 align-top">
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        checked={selectedById.has(row.id)}
                        onChange={() => toggleSelect(row)}
                        className="rounded border-slate-600"
                      />
                    </td>
                    <td className="px-1 py-2">
                      <button
                        type="button"
                        onClick={() => {
                          toggleExpand(row.id);
                          if (!ex) void loadActivityPreview(row);
                        }}
                        className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-700"
                        title="Expandir detalhes"
                      >
                        {ex ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex flex-col gap-0.5">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border text-center ${rb.className}`}>{rb.label}</span>
                        <span className="text-[10px] text-slate-500 font-mono text-center">{row.riskScore}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded whitespace-nowrap ${
                          row.status === 'blocked' ? 'bg-red-900/50 text-red-200' : 'bg-emerald-900/40 text-emerald-200'
                        }`}
                      >
                        {row.status === 'blocked' ? 'Desactiv.' : 'Activo'}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-slate-300 text-xs truncate" title={row.accessLevel ?? ''}>
                      {row.accessLevel ?? '—'}
                    </td>
                    <td className="px-2 py-2 text-white font-medium text-xs truncate" title={row.username}>
                      {row.username}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-sm text-slate-100 truncate flex-1 min-w-0" title={row.email}>
                          {row.email}
                        </span>
                        <button
                          type="button"
                          onClick={() => void copyText('Email', row.email)}
                          className="shrink-0 inline-flex p-1 rounded bg-slate-700 hover:bg-slate-600 text-white"
                          title="Copiar email"
                        >
                          <Copy size={14} />
                        </button>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-slate-400 font-mono text-xs truncate" title={row.emailDomain ?? ''}>
                      {row.emailDomain ?? '—'}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto custom-scrollbar">
                        {row.reasons.length === 0 ? (
                          <span className="text-[9px] px-1.5 py-0.5 rounded border border-slate-600 text-slate-500">—</span>
                        ) : (
                          row.reasons.map((c) => (
                            <span
                              key={c}
                              className={`text-[9px] font-bold px-1.5 py-0.5 rounded border leading-tight ${badgeClass(c)}`}
                              title={c}
                            >
                              {REASON_LABEL[c] ?? c}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-slate-400 text-[11px] whitespace-nowrap">{formatTs(row.createdAt)}</td>
                    <td className="px-2 py-2 text-slate-400 text-[11px] whitespace-nowrap">{formatTs(row.lastLoginAt)}</td>
                    <td className="px-2 py-2 text-[11px]">{row.hasMinedFlag ? <span className="text-emerald-400">Sim</span> : <span className="text-slate-500">Não</span>}</td>
                    <td className="px-2 py-2 text-slate-300 font-mono text-[11px] whitespace-nowrap">{fmtNum(row.totalHash)}</td>
                    <td className="px-2 py-2 text-[11px]">{row.walletAddress ? <span className="text-emerald-400">Sim</span> : <span className="text-slate-500">Não</span>}</td>
                    <td className="px-2 py-2 text-slate-300 font-mono text-[11px] whitespace-nowrap">{fmtNum(row.totalDepositedUsdc)}</td>
                    <td className="px-2 py-2 text-xs text-slate-400 truncate" title={row.referrer?.username || ''}>
                      {row.referrer?.username ?? '—'}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            requestOpenUserInEditor({
                              key: Date.now(),
                              userId: row.id,
                              email: row.email,
                              username: row.username,
                            })
                          }
                          className="inline-flex items-center gap-0.5 px-1.5 py-1 rounded bg-amber-700/80 hover:bg-amber-600 text-white text-[9px] font-bold"
                        >
                          <UserCircle size={11} />
                          Perfil
                        </button>
                        <button
                          type="button"
                          onClick={() => void copyText('ID', String(row.id))}
                          className="inline-flex items-center gap-0.5 px-1.5 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-[9px] font-bold"
                        >
                          <Hash size={11} />
                          ID
                        </button>
                        {row.referrer?.id != null &&
                          row.referrer.id > 0 &&
                          row.referrer.username &&
                          row.referrer.email && (
                          <button
                            type="button"
                            onClick={() =>
                              requestOpenUserInEditor({
                                key: Date.now(),
                                userId: row.referrer.id as number,
                                email: row.referrer.email as string,
                                username: row.referrer.username as string,
                              })
                            }
                            className="inline-flex items-center gap-0.5 px-1.5 py-1 rounded bg-cyan-900/60 hover:bg-cyan-800 text-white text-[9px] font-bold"
                            title="Abrir indicador (dados completos na BD)"
                          >
                            <Users size={11} />
                            Ref.
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            toggleExpand(row.id);
                            if (!ex) void loadActivityPreview(row);
                          }}
                          className="inline-flex items-center gap-0.5 px-1.5 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-[9px] font-bold"
                        >
                          <Activity size={11} />
                          Log
                        </button>
                      </div>
                    </td>
                  </tr>
                  {ex && (
                    <tr className="bg-slate-950/80 border-t border-slate-800">
                      <td colSpan={17} className="px-4 py-3 text-xs text-slate-300 space-y-2">
                        <div className="font-mono text-slate-200 break-all">
                          <span className="text-slate-500">Email completo:</span> {row.email}
                        </div>
                        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 text-slate-400">
                          <div>
                            Soma saldos moedas (índice): <span className="text-white font-mono">{fmtNum(row.totalMinedUsd)}</span>
                          </div>
                          <div>
                            Hash total (racks): <span className="text-white font-mono">{fmtNum(row.totalHash)}</span>
                          </div>
                          <div>
                            Carteira:{' '}
                            <span className="text-white font-mono break-all">{row.walletAddress ?? '—'}</span>
                          </div>
                          <div>
                            Indicador:{' '}
                            <span className="text-white">
                              {row.referrer?.username ?? '—'}{' '}
                              {row.referrer?.email ? <span className="text-slate-500">({row.referrer.email})</span> : null}
                            </span>
                          </div>
                        </div>
                        <div>
                          <span className="text-slate-500 font-bold">Actividade (pré-visualização)</span>
                          <pre className="mt-1 p-2 rounded bg-slate-900 border border-slate-800 text-[11px] text-slate-300 whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
                            {activityLines[row.id] ?? 'A carregar…'}
                          </pre>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {report?.pagination && report.pagination.total > limit && (
        <div className="flex items-center justify-between text-sm text-slate-400">
          <span>
            Página {report.pagination.page} de {Math.max(1, Math.ceil(report.pagination.total / limit))} (
            {report.pagination.total} contas)
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-3 py-1 rounded bg-slate-700 text-white disabled:opacity-40"
            >
              Anterior
            </button>
            <button
              type="button"
              disabled={loading || page * limit >= report.pagination.total}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1 rounded bg-slate-700 text-white disabled:opacity-40"
            >
              Seguinte
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
