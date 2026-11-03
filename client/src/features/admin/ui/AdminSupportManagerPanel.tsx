import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Search, UserMinus } from 'lucide-react';
import {
  getAdminSupportAccountManager,
  getAdminSupportAccountManagerByEmail,
  postAdminSupportFireManager,
  type AdminSupportAccountManagerActive,
} from '../../../shared/api/supportTicketsApi';

type Props = {
  /** Quando > 0, carrega automaticamente a gerência deste jogador (ticket). */
  ownerUserId?: number;
  /** Se true, mostra busca por email no topo (atalho sem ticket). */
  showEmailLookup?: boolean;
  /**
   * `toolbar`: só o botão vermelho (para a barra Conversa / Copiar / Gerir perfil).
   * `full` (default): painel com detalhes + lista de contas geridas.
   */
  variant?: 'full' | 'toolbar';
};

function formatMs(ts: number | null): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts).toLocaleString('pt-BR');
}

export const AdminSupportManagerPanel: React.FC<Props> = ({
  ownerUserId = 0,
  showEmailLookup = false,
  variant = 'full',
}) => {
  const [loading, setLoading] = useState(ownerUserId > 0);
  const [busyOwnerId, setBusyOwnerId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [active, setActive] = useState<AdminSupportAccountManagerActive | null>(null);
  const [managing, setManaging] = useState<AdminSupportAccountManagerActive[]>([]);
  const [resolvedUserId, setResolvedUserId] = useState(0);
  const [resolvedLabel, setResolvedLabel] = useState('');
  const [emailQuery, setEmailQuery] = useState('');

  const applyStatus = useCallback(
    (r: Awaited<ReturnType<typeof getAdminSupportAccountManager>>) => {
      if (!r.ok) {
        setError(r.error);
        setActive(null);
        setManaging([]);
        setResolvedUserId(0);
        setResolvedLabel('');
        return;
      }
      setEnabled(r.enabled);
      setActive(r.active);
      setManaging(r.managing);
      setResolvedUserId(r.userId);
      setResolvedLabel(
        [r.username, r.email].filter(Boolean).join(' · ') || (r.userId > 0 ? `#${r.userId}` : '')
      );
    },
    []
  );

  const loadByUserId = useCallback(
    async (userId: number) => {
      if (!Number.isFinite(userId) || userId <= 0) {
        setLoading(false);
        setEnabled(true);
        setActive(null);
        setManaging([]);
        setError(showEmailLookup ? null : 'Jogador sem userId — não é possível ver a gerência.');
        return;
      }
      setLoading(true);
      setError(null);
      const r = await getAdminSupportAccountManager(userId);
      setLoading(false);
      applyStatus(r);
    },
    [applyStatus, showEmailLookup]
  );

  useEffect(() => {
    if (ownerUserId > 0) void loadByUserId(ownerUserId);
  }, [ownerUserId, loadByUserId]);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const searchByEmail = async () => {
    const em = emailQuery.trim();
    if (!em) {
      setError('Informe um email para buscar.');
      return;
    }
    setLoading(true);
    setError(null);
    const r = await getAdminSupportAccountManagerByEmail(em);
    setLoading(false);
    applyStatus(r);
  };

  const fireOwner = async (ownerId: number, managerLabel: string) => {
    if (busyOwnerId != null) return;
    const ok = window.confirm(
      `Demitir o gerente ${managerLabel} da conta #${ownerId}?\n\nEncerra o contrato imediatamente (mesmo dentro da trava de 7 dias) e força a saída se o gerente estiver dentro da conta.`
    );
    if (!ok) return;
    setBusyOwnerId(ownerId);
    setError(null);
    const r = await postAdminSupportFireManager(ownerId);
    setBusyOwnerId(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setNotice('Gerente demitido / contrato encerrado.');
    if (resolvedUserId > 0) await loadByUserId(resolvedUserId);
    else if (ownerUserId > 0) await loadByUserId(ownerUserId);
  };

  const onToolbarFire = () => {
    if (loading || busyOwnerId != null) return;
    if (!enabled) {
      window.alert('Gerência de conta desativada neste ambiente.');
      return;
    }
    if (active) {
      void fireOwner(
        active.ownerUserId > 0 ? active.ownerUserId : resolvedUserId || ownerUserId,
        active.managerUsername || active.managerEmail || `#${active.managerUserId}`
      );
      return;
    }
    if (managing.length === 1) {
      const c = managing[0];
      void fireOwner(c.ownerUserId, c.ownerUsername || c.ownerEmail || `#${c.ownerUserId}`);
      return;
    }
    if (managing.length > 1) {
      window.alert(
        `Este jogador gere ${managing.length} contas. Usa a lista em “Gerência de conta” abaixo para escolher qual encerrar.`
      );
      return;
    }
    window.alert('Este jogador não tem gerente ativo (nem contas geridas). Não há o que demitir.');
  };

  if (variant === 'toolbar') {
    const canAct = enabled && (!!active || managing.length > 0);
    return (
      <button
        type="button"
        disabled={loading || busyOwnerId != null || ownerUserId <= 0}
        onClick={onToolbarFire}
        className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-bold uppercase disabled:opacity-40 ${
          canAct
            ? 'border-red-600/80 bg-red-700/90 text-white hover:bg-red-600'
            : 'border-red-900/50 bg-red-950/40 text-red-300/90 hover:bg-red-950/60'
        }`}
        title={
          canAct
            ? 'Demitir gerente / encerrar contrato ativo'
            : 'Sem contrato ativo — clica para confirmar'
        }
      >
        {loading || busyOwnerId != null ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <UserMinus size={12} />
        )}
        Demitir gerente
      </button>
    );
  }

  const hasAny = !!active || managing.length > 0;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2.5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Gerência de conta</div>
        {loading && <Loader2 size={14} className="animate-spin text-slate-500" />}
      </div>

      {showEmailLookup && (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void searchByEmail();
          }}
        >
          <input
            type="email"
            value={emailQuery}
            onChange={(e) => setEmailQuery(e.target.value)}
            placeholder="Email do jogador (dono ou gerente)"
            className="flex-1 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-[11px] font-bold uppercase text-white hover:bg-amber-500 disabled:opacity-50"
          >
            <Search size={12} /> Buscar gerência
          </button>
        </form>
      )}

      {notice && (
        <div className="rounded border border-emerald-800/60 bg-emerald-950/40 px-2 py-1.5 text-[11px] text-emerald-200">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded border border-red-800/60 bg-red-950/40 px-2 py-1.5 text-[11px] text-red-200">
          {error}
        </div>
      )}

      {!loading && !enabled && (
        <p className="text-[11px] text-slate-500">Gerência de conta desativada neste ambiente.</p>
      )}

      {!loading && enabled && resolvedLabel && (
        <p className="text-[11px] text-slate-400">
          Jogador: <span className="font-semibold text-slate-200">{resolvedLabel}</span>
        </p>
      )}

      {/* Botão sempre visível no painel */}
      {!loading && enabled && (resolvedUserId > 0 || ownerUserId > 0) && (
        <button
          type="button"
          disabled={busyOwnerId != null}
          onClick={onToolbarFire}
          className={`inline-flex w-full sm:w-auto items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-bold uppercase text-white disabled:opacity-50 ${
            hasAny ? 'bg-red-700/90 hover:bg-red-600' : 'bg-red-950/70 border border-red-800/60 hover:bg-red-900/60'
          }`}
        >
          {busyOwnerId != null ? <Loader2 size={12} className="animate-spin" /> : <UserMinus size={12} />}
          Demitir gerente
        </button>
      )}

      {!loading && enabled && !hasAny && !error && (resolvedUserId > 0 || ownerUserId > 0) && (
        <p className="text-[11px] text-slate-500">
          Sem contrato ativo neste momento — o botão acima avisa se não houver o que demitir.
        </p>
      )}

      {!loading && enabled && active && (
        <div className="rounded-md border border-amber-900/40 bg-amber-950/20 px-2.5 py-2 space-y-1">
          <div className="text-[10px] font-bold uppercase text-amber-500/90">Gerente desta conta</div>
          <div className="text-[12px] text-slate-300">
            <span className="font-semibold text-amber-300">
              {active.managerUsername || active.managerEmail || `#${active.managerUserId}`}
            </span>
            <span className="text-slate-500"> · desde {formatMs(active.hiredAt)}</span>
          </div>
          {!active.canFire && active.fireLockedUntil != null && (
            <div className="text-[11px] text-amber-400/90">
              Trava do jogador até {formatMs(active.fireLockedUntil)} — o suporte pode demitir na mesma.
            </div>
          )}
        </div>
      )}

      {!loading && enabled && managing.length > 0 && (
        <div className="rounded-md border border-slate-600 bg-slate-900/40 px-2.5 py-2 space-y-2">
          <div className="text-[10px] font-bold uppercase text-slate-400">
            Contas que este jogador gere ({managing.length})
          </div>
          <ul className="space-y-2">
            {managing.map((c) => {
              const ownerLabel = c.ownerUsername || c.ownerEmail || `#${c.ownerUserId}`;
              const busy = busyOwnerId === c.ownerUserId;
              return (
                <li
                  key={c.id}
                  className="flex flex-col gap-2 rounded border border-slate-700/80 px-2 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="text-[12px] text-slate-300">
                    <div className="font-semibold text-slate-100">{ownerLabel}</div>
                    <div className="text-[11px] text-slate-500">Desde {formatMs(c.hiredAt)}</div>
                  </div>
                  <button
                    type="button"
                    disabled={busyOwnerId != null}
                    onClick={() => void fireOwner(c.ownerUserId, 'deste contrato')}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-red-700/90 px-3 py-1.5 text-[11px] font-bold uppercase text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <UserMinus size={12} />}
                    Encerrar / demitir
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
};
