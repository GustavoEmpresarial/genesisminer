/**
 * Minha carteira — layout legado (App.tsx wallet view):
 * grid Exchange | WalletActions | ESTATÍSTICAS.
 * Sem cards inventados de "Saldo USDC / Saldos minerados".
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { useT } from '../../../shared/i18n';
import {
  getWalletState,
  getWeb3Settings,
  postExchangeLiquidate,
  requestWithdrawal,
  verifyDeposit,
  type WalletStatePayload,
  type Web3Settings
} from '../../../shared/api/wallet';
import { newWheelIdempotencyKey } from '../../../shared/api/wheel';
import { UiNoticeModal, type UiNotice } from '../../../shared/ui/UiNoticeModal';
import type { User } from '../../../shared/types/auth';
import type { GameView } from '../../game/nav/buildGameNavItems';
import { Exchange } from './Exchange';
import { WalletActions, type WalletWithdrawResult } from './WalletActions';
import { sendUsdcDeposit } from '../lib/sendUsdcDeposit';
import {
  findWithdrawTokenCfg,
  isWithdrawTokenUsable,
  minimumWithdrawCryptoAmount
} from '../../../shared/utils/withdrawTokenMatch';

export type WalletPageProps = {
  user: User;
  onUsdcChange?: (n: number) => void;
  onUserUpdate?: (partial: { username?: string; polygonWallet?: string | null }) => void;
  onNavigate?: (view: GameView) => void;
  /** Opcional — legado usava placedRacks; sem gameState monólito fica 0. */
  activeMachines?: number;
  placedRacksCount?: number;
};

export const WalletPage: React.FC<WalletPageProps> = ({
  user,
  onUsdcChange,
  onUserUpdate,
  onNavigate,
  activeMachines = 0,
  placedRacksCount = 0
}) => {
  const t = useT();
  const [walletState, setWalletState] = useState<WalletStatePayload | null>(null);
  const [web3Settings, setWeb3Settings] = useState<Web3Settings | null>(null);
  const [notice, setNotice] = useState<UiNotice | null>(null);
  const [depositFlow, setDepositFlow] = useState<{
    pending: boolean;
    status?: 'awaiting' | 'success' | 'queued' | 'cancelled' | 'failed';
    amount?: number;
    txHash?: string;
    network?: string;
    failureReason?: string;
  }>({ pending: false });

  const applyWalletState = useCallback(
    (ws: WalletStatePayload | null) => {
      if (!ws?.ok) return;
      setWalletState(ws);
      onUsdcChange?.(ws.usdcBalance);
      if (ws.polygonWallet !== undefined && ws.polygonWallet !== user.polygonWallet) {
        onUserUpdate?.({ polygonWallet: ws.polygonWallet });
      }
    },
    [onUsdcChange, onUserUpdate, user.polygonWallet]
  );

  const patchBalancesAfterMutation = useCallback(
    (coinId: string, patch: { newUsdc?: number; newCoinBalance?: number }) => {
      setWalletState((prev) => {
        if (!prev?.ok) return prev;
        const feePercent = prev.exchange?.feePercent ?? 0;
        const minedBalances = prev.minedBalances.map((m) => {
          if (m.coinId !== coinId || typeof patch.newCoinBalance !== 'number') return m;
          const bal = patch.newCoinBalance;
          const rate = m.usdcRate || 0;
          const gross = bal * rate;
          const fee = gross * (feePercent / 100);
          return {
            ...m,
            minedBalance: bal,
            grossUsdcEstimate: gross,
            feeUsdcEstimate: fee,
            netUsdcEstimate: gross - fee
          };
        });
        const usdcBalance =
          typeof patch.newUsdc === 'number' && Number.isFinite(patch.newUsdc)
            ? patch.newUsdc
            : prev.usdcBalance;
        if (typeof patch.newUsdc === 'number' && Number.isFinite(patch.newUsdc)) {
          onUsdcChange?.(patch.newUsdc);
        }
        return { ...prev, usdcBalance, minedBalances };
      });
    },
    [onUsdcChange]
  );

  const loadAll = useCallback(async () => {
    const [ws, w3] = await Promise.all([getWalletState(), getWeb3Settings()]);
    applyWalletState(ws);
    setWeb3Settings(w3);
  }, [applyWalletState]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const withdrawTokens = useMemo(() => {
    if (walletState?.ok && Array.isArray(walletState.withdrawTokens) && walletState.withdrawTokens.length) {
      return walletState.withdrawTokens as Web3Settings['withdrawTokens'];
    }
    return web3Settings?.withdrawTokens;
  }, [walletState, web3Settings]);

  const deskCoinBalances = useMemo(() => {
    if (walletState?.ok && Array.isArray(walletState.minedBalances)) {
      const acc: Record<string, number> = {};
      for (const m of walletState.minedBalances) {
        acc[m.coinId] =
          typeof m.minedBalance === 'number' && Number.isFinite(m.minedBalance) ? m.minedBalance : 0;
      }
      return acc;
    }
    return {};
  }, [walletState]);

  const deskMiningCoins = useMemo(() => {
    if (walletState?.ok && Array.isArray(walletState.minedBalances)) {
      return walletState.minedBalances.map((m) => ({
        id: m.coinId,
        name: m.name,
        symbol: m.symbol || m.name,
        usdcRate: m.usdcRate,
        showInExchange: m.showInExchange !== false
      }));
    }
    return [];
  }, [walletState]);

  const walletActionsCoins = useMemo(() => {
    if (walletState?.ok && Array.isArray(walletState.minedBalances)) {
      return walletState.minedBalances.map((m) => ({
        id: m.coinId,
        name: m.name,
        symbol: m.symbol || m.name,
        priceUSD: m.usdcRate || 0,
        usdcRate: m.usdcRate
      }));
    }
    return [];
  }, [walletState]);

  const serverDeskSettings = useMemo(() => {
    if (!walletState?.ok) return null;
    return {
      minExchangeAmount: walletState.exchange.minUsdc,
      exchangeFeePercent: walletState.exchange.feePercent
    };
  }, [walletState]);

  const handleSellCoin = useCallback(
    async (coinId: string, percentagePoints: 10 | 50 | 100) => {
      if (!user.email) {
        setNotice({ variant: 'error', title: t('wallet.sessionInvalid'), message: t('wallet.loginToLiquidate') });
        return;
      }
      if (percentagePoints === 100) {
        if (!window.confirm(t('wallet.liquidateConfirm'))) return;
      }
      const idem = newWheelIdempotencyKey();
      const res = await postExchangeLiquidate({
        coinId,
        mode: 'PERCENTAGE',
        percentage: percentagePoints,
        idempotencyKey: idem
      });
      if (res.ok === false) {
        if (res.status === 409 || res.status === 422) {
          const ws = await getWalletState();
          applyWalletState(ws);
          setNotice({
            variant: 'info',
            title: t('wallet.balanceUpdated'),
            message: res.error || 'O saldo foi sincronizado — tente novamente.'
          });
          return;
        }
        setNotice({
          variant: 'error',
          title: t('wallet.liquidateFailed'),
          message: res.error || 'Não foi possível concluir a operação.'
        });
        return;
      }
      if (typeof res.newUsdc === 'number' || typeof res.newCoinBalance === 'number') {
        patchBalancesAfterMutation(coinId, {
          newUsdc: res.newUsdc,
          newCoinBalance: res.newCoinBalance
        });
      } else {
        const ws = await getWalletState();
        applyWalletState(ws);
      }
      const feeMsg = res.feeUsdc && res.feeUsdc > 0 ? ` (Taxa: $${Number(res.feeUsdc).toFixed(4)})` : '';
      setNotice({
        variant: 'success',
        title: t('wallet.liquidateDone'),
        message: `+$${Number(res.netUsdc ?? 0).toFixed(4)} USDC${feeMsg}`
      });
    },
    [user.email, applyWalletState, patchBalancesAfterMutation, t]
  );

  const polygonWallet = walletState?.polygonWallet ?? user.polygonWallet ?? null;

  const verifyDepositWithServer = useCallback(
    async (txHash: string, network: string): Promise<{ ok: boolean; pending?: boolean; error?: string }> => {
      const txNorm = String(txHash || '')
        .trim()
        .toLowerCase();
      const verifyData = await verifyDeposit({ txHash: txNorm, network });
      if (verifyData.ok) {
        if (typeof verifyData.newUsdc === 'number') {
          setWalletState((prev) => {
            if (!prev?.ok) return prev;
            onUsdcChange?.(verifyData.newUsdc!);
            return { ...prev, usdcBalance: verifyData.newUsdc! };
          });
        } else {
          const ws = await getWalletState();
          applyWalletState(ws);
        }
        return { ok: true };
      }
      if (verifyData.pending) return { ok: false, pending: true };
      return { ok: false, error: verifyData.error || 'Falha na validação.' };
    },
    [applyWalletState, onUsdcChange]
  );

  useEffect(() => {
    if (depositFlow.status !== 'queued' || !depositFlow.txHash) return;
    const network = depositFlow.network || 'polygon';
    const txHash = depositFlow.txHash;
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 20;
    const tick = async () => {
      if (cancelled || attempts++ >= maxAttempts) return;
      const out = await verifyDepositWithServer(txHash, network);
      if (cancelled) return;
      if (out.ok) {
        setDepositFlow((f) => ({ ...f, status: 'success' }));
      }
    };
    const id = window.setInterval(tick, 30000);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [depositFlow.status, depositFlow.txHash, depositFlow.network, verifyDepositWithServer]);

  const handleWithdrawCoin = useCallback(
    async (coinId: string, amount: number): Promise<WalletWithdrawResult> => {
      const coin = walletActionsCoins.find((c) => c.id === coinId);
      if (!polygonWallet || !coin) {
        return { ok: false, error: t('wallet.connectWalletToWithdraw') };
      }
      const matching = findWithdrawTokenCfg(withdrawTokens, coin);
      if (!matching || !isWithdrawTokenUsable(matching)) {
        return {
          ok: false,
          error: `Saque indisponível para ${coin.symbol || coin.name}. Confirma a configuração no painel administrativo.`
        };
      }
      const minW = minimumWithdrawCryptoAmount(coin, matching);
      const cur = deskCoinBalances[coinId] || 0;
      if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: t('wallet.invalidWithdrawAmount') };
      }
      if (minW > 0 && amount + 1e-12 < minW) {
        return {
          ok: false,
          error: `O valor mínimo para saque (bruto) é ${minW.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${coin.symbol}.`
        };
      }
      if (amount > cur + 1e-9) {
        return {
          ok: false,
          error: `Saldo insuficiente. Você tem ${cur.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${coin.symbol} disponíveis.`
        };
      }
      const idempotencyKey = `wd_${newWheelIdempotencyKey()}`;
      const res = await requestWithdrawal(coinId, amount, polygonWallet, idempotencyKey);
      if (res.ok) {
        patchBalancesAfterMutation(coinId, { newCoinBalance: Math.max(0, cur - amount) });
        return {
          ok: true,
          message:
            res.message ||
            'Solicitação de saque enviada com sucesso. O saque será confirmado em até 24 horas.'
        };
      }
      if (res.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
        return { ok: false, error: res.error || 'Pedido em conflito. Recarrega o estado da carteira.' };
      }
      const status = res.status ?? 0;
      if (status >= 400 && status < 500 && res.error) {
        return { ok: false, error: res.error };
      }
      if (status >= 500) {
        return { ok: false, error: t('wallet.withdrawServerError') };
      }
      return { ok: false, error: res.error || t('wallet.withdrawRequestError') };
    },
    [polygonWallet, walletActionsCoins, withdrawTokens, deskCoinBalances, patchBalancesAfterMutation, t]
  );

  const handleStartDeposit = useCallback(
    async (amt: number, network: string = 'polygon') => {
      const minDep = web3Settings?.minDepositUsdc ?? 0.001;
      if (!amt || amt < minDep || !polygonWallet) return;
      const s = web3Settings ?? (await getWeb3Settings());
      if (!s) {
        setDepositFlow({
          pending: false,
          status: 'failed',
          amount: amt,
          network,
          failureReason: 'Não foi possível carregar as configurações de depósito.'
        });
        return;
      }
      setDepositFlow({ pending: true, status: 'awaiting', amount: amt, network });
      const res = await sendUsdcDeposit({
        amount: amt,
        network,
        polygonWallet,
        settings: s
      });
      if (res && res.tx && !res.cancelled) {
        try {
          const verifyDataResult = await verifyDepositWithServer(res.tx, network);
          if (verifyDataResult.ok) {
            setDepositFlow({ pending: false, status: 'success', amount: amt, txHash: res.tx, network });
          } else if (verifyDataResult.pending) {
            setDepositFlow({ pending: false, status: 'queued', amount: amt, txHash: res.tx, network });
            setNotice({ variant: 'info', title: t('wallet.depositSent'), message: t('wallet.depositQueuedHint') });
          } else {
            setDepositFlow({
              pending: false,
              status: 'failed',
              amount: amt,
              txHash: res.tx,
              network,
              failureReason: verifyDataResult.error || 'Não foi possível validar o depósito.'
            });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : '';
          setDepositFlow({
            pending: false,
            status: 'failed',
            amount: amt,
            txHash: res.tx,
            network,
            failureReason: msg ? `Erro ao falar com o servidor: ${msg}` : t('wallet.depositVerifyNetworkError')
          });
        }
      } else if (res && res.cancelled) {
        setDepositFlow({ pending: false, status: 'cancelled', amount: amt, network });
      } else {
        setDepositFlow({
          pending: false,
          status: 'failed',
          amount: amt,
          txHash: res?.tx,
          network,
          failureReason: res?.error
        });
      }
    },
    [polygonWallet, web3Settings, verifyDepositWithServer, t]
  );

  const handleVerifyDepositByHash = useCallback(
    async (txHash: string, network: 'polygon' | 'bnb' | 'base') => {
      return verifyDepositWithServer(txHash, network);
    },
    [verifyDepositWithServer]
  );

  return (
    <div className="flex flex-1 flex-col space-y-6 p-6 animate-in fade-in slide-in-from-left-4 duration-300">
      <div className="flex-1">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-2">
          <Exchange
            coinBalances={deskCoinBalances}
            miningCoins={deskMiningCoins}
            onSellCoin={handleSellCoin}
            serverDeskSettings={serverDeskSettings}
          />
          <WalletActions
            onAddUSDC={(amt, network) => {
              void handleStartDeposit(amt, network || 'polygon');
            }}
            onStartDeposit={(amt, network) => {
              void handleStartDeposit(amt, network || 'polygon');
            }}
            hasWallet={!!polygonWallet}
            coinBalances={deskCoinBalances}
            miningCoins={walletActionsCoins}
            coinRates={{}}
            onWithdrawCoin={handleWithdrawCoin}
            withdrawTokens={withdrawTokens}
            minDepositUsdc={web3Settings?.minDepositUsdc}
            depositPolygonDisabled={web3Settings?.depositPolygonDisabled}
            depositBnbDisabled={web3Settings?.depositBnbDisabled}
            depositBaseDisabled={web3Settings?.depositBaseDisabled}
            depositStatus={depositFlow.status}
            depositAmount={depositFlow.amount}
            depositFailureMessage={depositFlow.failureReason}
            onCloseDepositStatus={() => setDepositFlow({ pending: false })}
            userEmail={user.email || null}
            onVerifyDepositByHash={handleVerifyDepositByHash}
            onSyncQueuedDeposit={
              depositFlow.status === 'queued' && depositFlow.txHash
                ? async () => {
                    const net = depositFlow.network || 'polygon';
                    const out = await verifyDepositWithServer(depositFlow.txHash!, net);
                    if (out.ok) setDepositFlow((f) => ({ ...f, status: 'success' }));
                    else if (out.pending) {
                      setNotice({
                        variant: 'info',
                        title: t('wallet.awaitingNetwork'),
                        message: t('wallet.stillAwaitingConfirm')
                      });
                    } else {
                      setNotice({
                        variant: 'error',
                        title: t('wallet.syncFailed'),
                        message: out.error || 'Não foi possível sincronizar.'
                      });
                    }
                  }
                : undefined
            }
            onOpenWithdrawalHistory={
              onNavigate ? () => onNavigate('withdrawal_history' as GameView) : undefined
            }
            onOpenDepositHistory={onNavigate ? () => onNavigate('deposit_history' as GameView) : undefined}
          />
          <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6 shadow-lg transition-colors dark:border-slate-800 dark:bg-slate-900 md:col-span-2 lg:col-span-2 xl:col-span-2">
            <div>
              <h3 className="mb-4 flex items-center gap-2 border-b border-slate-200 pb-2 font-bold text-slate-700 dark:border-slate-800 dark:text-slate-300">
                <LayoutDashboard size={18} /> {t('wallet.stats').toUpperCase()}
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="flex flex-col rounded border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
                  <span className="text-sm text-slate-500">{t('wallet.activeMachines')}</span>
                  <span className="font-mono text-slate-700 dark:text-slate-200">
                    {activeMachines} Unidades
                  </span>
                </div>
                <div className="flex flex-col rounded border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
                  <span className="text-sm text-slate-500">{t('wallet.installedRigs')}</span>
                  <span className="font-mono text-slate-700 dark:text-slate-200">
                    {placedRacksCount} Unidades
                  </span>
                </div>
              </div>
            </div>
            <div className="mt-8 border-t border-slate-200 pt-4 dark:border-slate-800" />
          </div>
        </div>
      </div>

      <UiNoticeModal notice={notice} onClose={() => setNotice(null)} overlayZClassName="z-[140]" />
    </div>
  );
};
