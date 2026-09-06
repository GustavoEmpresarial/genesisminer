import React, { useCallback, useEffect, useState } from 'react';
import { Briefcase, Check, Loader2, LogIn, Send, UserMinus, UserPlus, X } from 'lucide-react';
import {
  getAccountManagerMe,
  postAccountManagerAccept,
  postAccountManagerApply,
  postAccountManagerDecline,
  postAccountManagerEnter,
  postAccountManagerFire,
  postAccountManagerHire,
  postAccountManagerResign,
  type AccountManagerMeResponse
} from '../api/gerente';
import { GerenteEarningsCard } from './GerenteEarningsCard';

function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch {
    return String(ms);
  }
}

type GerentePageProps = {
  onSessionRefresh?: () => void | Promise<void> | boolean | Promise<boolean>;
};

export const GerentePage: React.FC<GerentePageProps> = ({ onSessionRefresh }) => {
  const [data, setData] = useState<AccountManagerMeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [hireTarget, setHireTarget] = useState('');
  const [applyTarget, setApplyTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getAccountManagerMe();
      if (!res.ok) {
        const disabled = res.code === 'ACCOUNT_MANAGER_DISABLED';
        setError(
          disabled
            ? 'A gerência de conta está desligada neste ambiente (ACCOUNT_MANAGER_ENABLED).'
            : res.error || 'Falha ao carregar gerência.'
        );
        setData(null);
      } else {
        setData(res);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro de rede');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const res = await action();
      if (!res.ok) {
        setError(res.error || 'Operação falhou.');
      } else {
        setOkMsg(success);
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro de rede');
    } finally {
      setBusy(false);
    }
  }

  const ownerActive = data?.asOwner?.find((c) => c.status === 'active');
  const ownerPending = data?.asOwner?.find((c) => c.status === 'pending');
  const ownerApplications = data?.asOwner?.filter((c) => c.status === 'applied') ?? [];
  const managerInvites = data?.asManager?.filter((c) => c.status === 'pending') ?? [];
  const managerApplications = data?.asManager?.filter((c) => c.status === 'applied') ?? [];
  const managerActive = data?.asManager?.filter((c) => c.status === 'active') ?? [];
  const activeManaged = data?.activeManagedCount ?? managerActive.length;
  const sharePercentLabel =
    data?.sharePercent != null && Number.isFinite(data.sharePercent) ? `${data.sharePercent}%` : null;
  const fireLockLabel =
    data?.fireLockDays != null && Number.isFinite(data.fireLockDays) ? `${data.fireLockDays} dias` : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 space-y-6">
      <header className="flex items-start gap-3">
        <div className="rounded-xl bg-amber-500/15 p-3 text-amber-500">
          <Briefcase size={22} />
        </div>
        <div>
          <h1 className="text-xl font-bold text-slate-100">Gerência de conta</h1>
          <p className="text-sm text-slate-400 mt-1">
            Contrata um jogador ou recebe candidaturas (“currículo”). O gerente trata check-in, moeda de farm,
            montar/desmontar rigs e máquinas
            {sharePercentLabel ? `, e recebe ${sharePercentLabel} do minerado (pago 1× por semana)` : ', e recebe parte do minerado (pago 1× por semana)'}
            .
            {fireLockLabel
              ? ` Demissão bloqueada por ${fireLockLabel} após o aceite.`
              : ' Demissão pode ficar bloqueada após o aceite.'}
          </p>
        </div>
      </header>

      {error && data ? (
        <div className="rounded-lg border border-red-500/40 bg-red-950/40 px-3 py-2 text-sm text-red-200">{error}</div>
      ) : null}
      {okMsg && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200">
          {okMsg}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <Loader2 className="animate-spin" size={16} /> A carregar…
        </div>
      ) : !data ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 px-4 py-6 text-sm text-amber-100/90">
          {error ||
            'Não foi possível carregar a gerência. Confirma que o servidor tem ACCOUNT_MANAGER_ENABLED=1 e reinicia a API.'}
        </div>
      ) : (
        <>
          <GerenteEarningsCard earnings={data.managerEarnings} sharePercent={data.sharePercent} />

          <section className="rounded-xl border border-slate-700/80 bg-slate-900/50 p-4 space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-300">Como dono</h2>
            {ownerActive ? (
              <div className="space-y-2 text-sm text-slate-300">
                <p>
                  Gerente ativo:{' '}
                  <span className="font-semibold text-amber-300">
                    {ownerActive.managerUsername || ownerActive.managerEmail}
                  </span>
                </p>
                <p className="text-slate-500">Contratado em {formatMs(ownerActive.hiredAt)}</p>
                {!ownerActive.canFire && (
                  <p className="text-amber-400/90">
                    Demissão bloqueada até {formatMs(ownerActive.fireLockedUntil)}
                  </p>
                )}
                <button
                  type="button"
                  disabled={busy || !ownerActive.canFire}
                  onClick={() => void run(() => postAccountManagerFire(), 'Gerente demitido.')}
                  className="inline-flex items-center gap-2 rounded-lg bg-red-600/80 hover:bg-red-500 disabled:opacity-40 px-3 py-2 text-sm font-semibold text-white"
                >
                  <UserMinus size={16} /> Demitir
                </button>
              </div>
            ) : (
              <>
                {ownerPending && (
                  <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-sm text-slate-300">
                    <p>
                      Convite pendente para{' '}
                      <span className="font-semibold text-amber-300">
                        {ownerPending.managerUsername || ownerPending.managerEmail}
                      </span>
                    </p>
                    <p className="text-slate-500">À espera do aceite do jogador.</p>
                  </div>
                )}

                {ownerApplications.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">
                      Candidaturas recebidas
                    </h3>
                    <ul className="space-y-2">
                      {ownerApplications.map((c) => (
                        <li
                          key={c.id}
                          className="flex flex-col gap-2 rounded-lg border border-slate-700/60 bg-slate-950/40 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="text-sm text-slate-300">
                            <div className="font-semibold text-slate-100">
                              {c.managerUsername || c.managerEmail || `User #${c.managerUserId}`}
                            </div>
                            <div className="text-slate-500">Enviado em {formatMs(c.createdAt)}</div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run(() => postAccountManagerAccept(c.id), 'Candidatura aprovada.')
                              }
                              className="inline-flex items-center gap-1 rounded-md bg-emerald-600/80 px-2.5 py-1.5 text-xs font-bold text-white"
                            >
                              <Check size={14} /> Aprovar
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run(() => postAccountManagerDecline(c.id), 'Candidatura rejeitada.')
                              }
                              className="inline-flex items-center gap-1 rounded-md bg-slate-600 px-2.5 py-1.5 text-xs font-bold text-white"
                            >
                              <X size={14} /> Rejeitar
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {!ownerPending && (
                  <form
                    className="flex flex-col gap-2 sm:flex-row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(() => postAccountManagerHire(hireTarget.trim()), 'Convite enviado.');
                      setHireTarget('');
                    }}
                  >
                    <input
                      value={hireTarget}
                      onChange={(e) => setHireTarget(e.target.value)}
                      placeholder="Email ou username do jogador"
                      className="flex-1 rounded-lg border border-slate-600 bg-slate-950/60 px-3 py-2 text-sm text-slate-100"
                      disabled={busy}
                    />
                    <button
                      type="submit"
                      disabled={busy || !hireTarget.trim()}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 px-3 py-2 text-sm font-bold text-stone-950"
                    >
                      <UserPlus size={16} /> Contratar
                    </button>
                  </form>
                )}
              </>
            )}
          </section>

          <section className="rounded-xl border border-slate-700/80 bg-slate-900/50 p-4 space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-300">Como gerente</h2>
              <p className="text-xs text-slate-500">
                Contas ativas: <span className="font-semibold text-slate-300">{activeManaged}</span>
              </p>
            </div>

            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  () => postAccountManagerApply(applyTarget.trim()),
                  'Candidatura enviada. Aguarda aprovação do dono.'
                );
                setApplyTarget('');
              }}
            >
              <input
                value={applyTarget}
                onChange={(e) => setApplyTarget(e.target.value)}
                placeholder="Email ou username do dono da conta"
                className="flex-1 rounded-lg border border-slate-600 bg-slate-950/60 px-3 py-2 text-sm text-slate-100"
                disabled={busy}
              />
              <button
                type="submit"
                disabled={busy || !applyTarget.trim()}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-500/50 bg-amber-500/15 hover:bg-amber-500/25 disabled:opacity-40 px-3 py-2 text-sm font-bold text-amber-200"
              >
                <Send size={16} /> Candidatar-me
              </button>
            </form>
            <p className="text-xs text-slate-500">
              Envia o teu “currículo”: o dono vê a candidatura e pode aprovar ou rejeitar.
            </p>

            {managerInvites.length === 0 &&
            managerApplications.length === 0 &&
            managerActive.length === 0 ? (
              <p className="text-sm text-slate-500">Nenhum pedido ou contrato como gerente.</p>
            ) : (
              <ul className="space-y-3">
                {managerInvites.map((c) => (
                  <li
                    key={c.id}
                    className="rounded-lg border border-slate-700/60 bg-slate-950/40 px-3 py-3 text-sm text-slate-300"
                  >
                    <div className="font-semibold text-slate-100">
                      {c.ownerUsername || c.ownerEmail || `User #${c.ownerUserId}`}
                    </div>
                    <div className="text-amber-400/90 mt-0.5">Convite recebido — aceita ou recusa</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run(() => postAccountManagerAccept(c.id), 'Contrato aceite.')}
                        className="inline-flex items-center gap-1 rounded-md bg-emerald-600/80 px-2.5 py-1.5 text-xs font-bold text-white disabled:opacity-40"
                      >
                        <Check size={14} /> Aceitar
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run(() => postAccountManagerDecline(c.id), 'Pedido recusado.')}
                        className="inline-flex items-center gap-1 rounded-md bg-slate-600 px-2.5 py-1.5 text-xs font-bold text-white"
                      >
                        <X size={14} /> Recusar
                      </button>
                    </div>
                  </li>
                ))}

                {managerApplications.map((c) => (
                  <li
                    key={c.id}
                    className="rounded-lg border border-slate-700/60 bg-slate-950/40 px-3 py-3 text-sm text-slate-300"
                  >
                    <div className="font-semibold text-slate-100">
                      {c.ownerUsername || c.ownerEmail || `User #${c.ownerUserId}`}
                    </div>
                    <div className="text-slate-500 mt-0.5">Candidatura enviada — à espera do dono</div>
                    <div className="mt-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(() => postAccountManagerResign(c.id), 'Candidatura cancelada.')
                        }
                        className="inline-flex items-center gap-1 rounded-md bg-slate-700 px-2.5 py-1.5 text-xs font-bold text-white"
                      >
                        Cancelar candidatura
                      </button>
                    </div>
                  </li>
                ))}

                {managerActive.map((c) => (
                  <li
                    key={c.id}
                    className="rounded-lg border border-slate-700/60 bg-slate-950/40 px-3 py-3 text-sm text-slate-300"
                  >
                    <div className="font-semibold text-slate-100">
                      {c.ownerUsername || c.ownerEmail || `User #${c.ownerUserId}`}
                    </div>
                    <div className="text-emerald-400/90 mt-0.5">Status: ativo</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          setError(null);
                          setOkMsg(null);
                          try {
                            const res = await postAccountManagerEnter(c.ownerUserId);
                            if (!res.ok) {
                              setError(res.error || 'Falha ao entrar.');
                              return;
                            }
                            await onSessionRefresh?.();
                          } catch (e) {
                            setError(e instanceof Error ? e.message : 'Erro de rede');
                          } finally {
                            setBusy(false);
                          }
                        }}
                        className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1.5 text-xs font-bold text-stone-950"
                      >
                        <LogIn size={14} /> Entrar na conta
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(() => postAccountManagerResign(c.id), 'Saíste do contrato.')
                        }
                        className="inline-flex items-center gap-1 rounded-md bg-red-700/80 px-2.5 py-1.5 text-xs font-bold text-white"
                      >
                        Resignar
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
};
