import React, { useState } from 'react';
import { useT } from '../../../shared/i18n';
import { web3DepositFlagDisabled } from '../../../shared/api/wallet';
import { CreditCard, Upload, HardDrive, Coins, TrendingUp, Shield, Clock } from 'lucide-react';
import { formatMinedCoinAmount } from '../../../shared/utils/locale-format';
import {
  findWithdrawTokenCfg,
  isWithdrawTokenUsable,
  minimumWithdrawCryptoAmount
} from '../../../shared/utils/withdrawTokenMatch';
import { UiNoticeModal, type UiNotice } from '../../../shared/ui/UiNoticeModal';
import { MiningCoinGlyph } from '../../../shared/ui/MiningCoinGlyph';

export type WalletWithdrawResult = { ok: boolean; message?: string; error?: string };

interface WalletActionsProps {
  onAddUSDC: (amount: number, network?: string) => void;
  onStartDeposit?: (amount: number, network?: string) => void;
  hasWallet?: boolean;
  coinBalances: Record<string, number>;
  miningCoins: { id: string; name: string; symbol: string; priceUSD: number; usdcRate?: number }[];
  coinRates?: Record<string, number>;
  /**
   * Callback de saque. Pode devolver `Promise<WalletWithdrawResult>` para o componente
   * mostrar feedback visual próprio (sucesso/erro via UiNoticeModal). Compat: void.
   */
  onWithdrawCoin: (coinId: string, amount: number) => void | Promise<WalletWithdrawResult | void>;
  withdrawTokens?: Array<{ name?: string; symbol?: string; coinId?: string; network?: 'polygon' | 'bnb' | 'base'; contract?: string; minAmount?: number; minWithdrawalUsdc?: number; feePercent?: number; disabled?: boolean }>;

  prefillAmount?: number;
  depositStatus?: 'awaiting' | 'success' | 'queued' | 'cancelled' | 'failed';
  depositAmount?: number;
  /** Detalhe quando depositStatus === 'failed' (ex.: mensagem do /api/deposit/verify). */
  depositFailureMessage?: string;
  onCloseDepositStatus?: () => void;
  minDepositUsdc?: number;
  depositPolygonDisabled?: boolean;
  depositBnbDisabled?: boolean;
  depositBaseDisabled?: boolean;
  /** Sessão: permite validar um hash colado (ex. envio feito só na carteira). */
  userEmail?: string | null;
  onVerifyDepositByHash?: (
    txHash: string,
    network: 'polygon' | 'bnb' | 'base'
  ) => Promise<{ ok: boolean; pending?: boolean; error?: string }>;
  /** Re-tentar POST /api/deposit/verify para o último depósito em fila. */
  onSyncQueuedDeposit?: () => Promise<void>;
  onOpenWithdrawalHistory?: () => void;
  onOpenDepositHistory?: () => void;
}

const MAX_USDC_DEPOSIT_UI = 50_000_000;

export const WalletActions: React.FC<WalletActionsProps> = ({
  onAddUSDC,
  onStartDeposit,
  hasWallet = false,
  coinBalances,
  miningCoins,
  coinRates = {},
  onWithdrawCoin,
  prefillAmount,
  withdrawTokens,
  depositStatus,
  depositAmount,
  depositFailureMessage,
  onCloseDepositStatus,
  minDepositUsdc,
  depositPolygonDisabled,
  depositBnbDisabled,
  depositBaseDisabled,
  userEmail,
  onVerifyDepositByHash,
  onSyncQueuedDeposit,
  onOpenWithdrawalHistory,
  onOpenDepositHistory
}) => {
  const t = useT();
  const [usdcAmount, setUsdcAmount] = useState<string>('');
  const [selectedNetwork, setSelectedNetwork] = useState<'polygon' | 'bnb' | 'base'>('polygon');
  const [selectedCoinId, setSelectedCoinId] = useState<string>(miningCoins[0]?.id || '');
  const [coinAmount, setCoinAmount] = useState<string>('');
  const [depositFieldError, setDepositFieldError] = useState<string>('');
  const [manualTxHash, setManualTxHash] = useState('');
  const [manualVerifyBusy, setManualVerifyBusy] = useState(false);
  const [syncQueuedBusy, setSyncQueuedBusy] = useState(false);
  const [withdrawNotice, setWithdrawNotice] = useState<UiNotice | null>(null);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  /** Modal de confirmação custom (substitui o `confirm()` nativo do legacy). */
  const [withdrawConfirm, setWithdrawConfirm] = useState<{
    coinId: string;
    symbol: string;
    amount: number;
    fee: number;
    feePercent: number;
    net: number;
  } | null>(null);

  React.useEffect(() => {
    if (miningCoins.length > 0 && !miningCoins.some(c => c.id === selectedCoinId)) {
      setSelectedCoinId(miningCoins[0].id);
    }
  }, [miningCoins, selectedCoinId]);

  const polyDepositOff = web3DepositFlagDisabled(depositPolygonDisabled);
  const bnbDepositOff = web3DepositFlagDisabled(depositBnbDisabled);
  const baseDepositOff = web3DepositFlagDisabled(depositBaseDisabled);
  const networkDepositAllowed = (id: 'polygon' | 'bnb' | 'base') => {
    if (id === 'polygon') return !polyDepositOff;
    if (id === 'bnb') return !bnbDepositOff;
    if (id === 'base') return !baseDepositOff;
    return true;
  };
  const allDepositNetworksDisabled = polyDepositOff && bnbDepositOff && baseDepositOff;
  const selectedDepositBlocked = !networkDepositAllowed(selectedNetwork);

  React.useEffect(() => {
    if (networkDepositAllowed(selectedNetwork)) return;
    const order: ('polygon' | 'bnb' | 'base')[] = ['polygon', 'bnb', 'base'];
    const next = order.find((id) => networkDepositAllowed(id));
    if (next) setSelectedNetwork(next);
  }, [polyDepositOff, bnbDepositOff, baseDepositOff, selectedNetwork]);

  const handleDeposit = () => {
    setDepositFieldError('');
    if (!hasWallet) {
      setDepositFieldError('Conecte uma carteira para depositar.');
      return;
    }
    if (allDepositNetworksDisabled) {
      setDepositFieldError('Depósitos USDC estão desativados em todas as redes.');
      return;
    }
    if (selectedDepositBlocked) {
      setDepositFieldError('Depósitos nesta rede estão desativados.');
      return;
    }
    const raw = usdcAmount.replace(/\s/g, '').replace(',', '.');
    const val = parseFloat(raw);
    const minDep = typeof minDepositUsdc === 'number' && Number.isFinite(minDepositUsdc) ? Math.max(0.000001, minDepositUsdc) : 0.001;
    if (!Number.isFinite(val) || val < minDep) {
      setDepositFieldError(`Informe um valor numérico ≥ ${minDep} USDC.`);
      return;
    }
    if (val > MAX_USDC_DEPOSIT_UI) {
      setDepositFieldError(t('wallet.amountAboveLimit'));
      return;
    }
    if (onStartDeposit) onStartDeposit(val, selectedNetwork);
    else onAddUSDC(val, selectedNetwork);
    setUsdcAmount('');
  };

  React.useEffect(() => {
    if (typeof prefillAmount === 'number' && prefillAmount > 0) {
      setUsdcAmount(String(prefillAmount));
    }
  }, [prefillAmount]);

  const formatAmount = (val: number) => formatMinedCoinAmount(val);

  /**
   * Helpers do bloco de saque — calculam, para a moeda selecionada, mínimo, taxa, e o motivo de bloqueio
   * exibido abaixo do botão SACAR. Cobrem todos os cenários do critério de aceite:
   *  - sem carteira conectada;
   *  - moeda não configurada / saque desativado no admin;
   *  - saldo abaixo do mínimo (saldo "1 DAI" com mínimo "1.0024 DAI" cai aqui);
   *  - valor digitado < mínimo;
   *  - valor digitado > saldo.
   */
  const selectedCoin = miningCoins.find(c => c.id === selectedCoinId);
  const selectedCfg = findWithdrawTokenCfg(withdrawTokens, selectedCoin);
  const selectedMatching = selectedCfg && isWithdrawTokenUsable(selectedCfg) ? selectedCfg : null;
  const selectedBalance = coinBalances[selectedCoinId] || 0;
  const selectedMin =
    selectedCoin && selectedMatching ? minimumWithdrawCryptoAmount(selectedCoin, selectedMatching) : 0;
  const selectedAmountNum = parseFloat(String(coinAmount).replace(/\s/g, '').replace(',', '.'));

  /** Motivo amigável que aparece abaixo do botão (vazio = tudo OK). */
  const withdrawDisabledReason: string = (() => {
    if (!hasWallet) return t('wallet.connectWalletToWithdraw');
    if (!selectedCfg) return `${selectedCoin?.symbol || 'Esta moeda'} não está configurado para saque no painel administrativo.`;
    if (selectedCfg.disabled) return `Saques de ${selectedCoin?.symbol || 'esta moeda'} estão temporariamente desativados.`;
    if (!selectedMatching) return `${selectedCoin?.symbol || 'Esta moeda'} ainda não tem contrato válido configurado.`;
    if (selectedMin > 0 && selectedBalance + 1e-9 < selectedMin) {
      return `Seu saldo (${formatAmount(selectedBalance)} ${selectedCoin?.symbol || ''}) ainda não atingiu o mínimo de saque (${formatAmount(selectedMin)} ${selectedCoin?.symbol || ''}).`;
    }
    if (!coinAmount || !Number.isFinite(selectedAmountNum) || selectedAmountNum <= 0) {
      return 'Digite o valor que deseja sacar.';
    }
    if (selectedMin > 0 && selectedAmountNum + 1e-9 < selectedMin) {
      return `Digite pelo menos ${formatAmount(selectedMin)} ${selectedCoin?.symbol || ''} para sacar.`;
    }
    if (selectedAmountNum > selectedBalance * (1 + 1e-9)) {
      return `Saldo insuficiente. Você tem ${formatAmount(selectedBalance)} ${selectedCoin?.symbol || ''} disponíveis.`;
    }
    return '';
  })();

  const withdrawCanSubmit = !withdrawBusy && withdrawDisabledReason === '';

  const handleUseMaxBalance = () => {
    const bal = selectedBalance;
    if (!(bal > 0)) {
      setWithdrawNotice({
        variant: 'info',
        title: t('wallet.noBalance'),
        message: `Nenhum saldo disponível em ${selectedCoin?.symbol || 'esta moeda'} para sacar.`
      });
      return;
    }
    // Floor to 8 decimals — `toFixed` rounds, which can exceed the real balance
    // and make the backend reject the "withdraw all" as insufficient.
    const floored = Math.floor(bal * 1e8) / 1e8;
    setCoinAmount(floored.toFixed(8).replace(/0+$/, '').replace(/\.$/, ''));
  };

  /** Passo 1: abrir modal de confirmação (não chama backend ainda). */
  const openWithdrawConfirm = () => {
    if (!withdrawCanSubmit || !selectedCoin || !selectedMatching) return;
    const feePercent = Number(selectedMatching.feePercent) || 0;
    const fee = (selectedAmountNum * feePercent) / 100;
    const net = Math.max(0, selectedAmountNum - fee);
    setWithdrawConfirm({
      coinId: selectedCoin.id,
      symbol: selectedCoin.symbol || selectedCoin.name || selectedCoin.id,
      amount: selectedAmountNum,
      fee,
      feePercent,
      net
    });
  };

  /** Passo 2: o modal chama isto para enviar o pedido ao backend. */
  const submitWithdrawRequest = async () => {
    if (!withdrawCanSubmit || !selectedCoin || !selectedMatching) return;
    if (withdrawBusy) return;
    setWithdrawConfirm(null);
    const amt = selectedAmountNum;
    const symbol = selectedCoin.symbol || selectedCoin.name || selectedCoin.id;
    setWithdrawBusy(true);
    try {
      const res = await Promise.resolve(onWithdrawCoin(selectedCoin.id, amt));
      if (res && typeof res === 'object' && 'ok' in res) {
        if (res.ok) {
          setCoinAmount('');
          setWithdrawNotice({
            variant: 'success',
            title: t('wallet.requestSent'),
            message:
              res.message ||
              `Solicitação de saque de ${formatAmount(amt)} ${symbol} criada com sucesso. O saque será confirmado em até 24 horas na sua carteira conectada.`
          });
        } else {
          setWithdrawNotice({
            variant: 'error',
            title: t('wallet.withdrawFailed'),
            message: res.error || 'Tente novamente em alguns instantes.'
          });
        }
      } else {
        setCoinAmount('');
        setWithdrawNotice({
          variant: 'success',
          title: t('wallet.requestSent'),
          message: `Solicitação de saque de ${formatAmount(amt)} ${symbol} enviada. O saque será confirmado em até 24 horas.`
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('wallet.withdrawProcessError');
      setWithdrawNotice({
        variant: 'error',
        title: t('wallet.withdrawFailed'),
        message: msg
      });
    } finally {
      setWithdrawBusy(false);
    }
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-lg flex flex-col gap-4 transition-colors">
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-2 mb-2">
        <CreditCard size={18} className="text-orange-500 dark:text-orange-400" />
        <h3 className="text-slate-800 dark:text-slate-300 font-bold">{t('wallet.depositEntries')}</h3>
      </div>
      <div className="flex flex-wrap gap-2">
      {onOpenWithdrawalHistory && (
        <button
          type="button"
          onClick={onOpenWithdrawalHistory}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:border-orange-400 hover:text-orange-500 transition-colors"
        >
          <Clock size={16} />
          Ver histórico de saques
        </button>
      )}
      {onOpenDepositHistory && (
        <button
          type="button"
          onClick={onOpenDepositHistory}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:border-green-400 hover:text-green-500 transition-colors"
        >
          <Clock size={16} />
          Ver histórico de depósitos
        </button>
      )}
      </div>
      {depositStatus && (
        <div
          className={
            depositStatus === 'awaiting'
              ? 'mt-3 p-3 rounded border text-center bg-yellow-50 border-yellow-200 text-yellow-700 dark:bg-yellow-900/20 dark:border-yellow-800 dark:text-yellow-400'
              : depositStatus === 'success'
                ? 'mt-3 p-3 rounded border text-center bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400'
                : depositStatus === 'queued'
                  ? 'mt-3 p-3 rounded border text-center bg-sky-50 border-sky-200 text-sky-800 dark:bg-sky-900/20 dark:border-sky-800 dark:text-sky-300'
                  : depositStatus === 'cancelled'
                    ? 'mt-3 p-3 rounded border text-center bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400'
                    : 'mt-3 p-3 rounded border text-center bg-orange-50 border-orange-200 text-orange-700 dark:bg-orange-900/20 dark:border-orange-800 dark:text-orange-400'
          }
        >
          {depositStatus === 'awaiting' && (
            <div className="text-[12px]">Aguardando confirmação na rede{typeof depositAmount === 'number' ? ` (${depositAmount} USDC)` : ''}.</div>
          )}
          {depositStatus === 'success' && (
            <div className="flex flex-col items-center gap-2">
              <div className="text-[12px] font-bold">{t('wallet.entryConfirmed')}</div>
              <button onClick={onCloseDepositStatus} className="text-[12px] bg-green-600 hover:bg-green-500 text-white px-3 py-1 rounded">{t('wallet.close')}</button>
            </div>
          )}
          {depositStatus === 'queued' && (
            <div className="flex flex-col items-center gap-2">
              <div className="text-[12px] font-bold">{t('wallet.queuedConfirm')}</div>
              <div className="text-[11px] opacity-90 text-center px-1">
                Os USDC serão creditados após a rede confirmar. O site tenta sincronizar automaticamente; também pode forçar abaixo.
              </div>
              {onSyncQueuedDeposit && (
                <button
                  type="button"
                  disabled={syncQueuedBusy}
                  onClick={async () => {
                    setSyncQueuedBusy(true);
                    try {
                      await onSyncQueuedDeposit();
                    } finally {
                      setSyncQueuedBusy(false);
                    }
                  }}
                  className="text-[12px] bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white px-3 py-1 rounded"
                >
                  {syncQueuedBusy ? '…' : t('wallet.syncNow')}
                </button>
              )}
              <button type="button" onClick={onCloseDepositStatus} className="text-[12px] bg-slate-600 hover:bg-slate-500 text-white px-3 py-1 rounded">{t('wallet.gotIt')}</button>
            </div>
          )}
          {depositStatus === 'cancelled' && (
            <div className="flex flex-col items-center gap-2">
              <div className="text-[12px] font-bold">{t('wallet.txCancelled')}</div>
              <button onClick={onCloseDepositStatus} className="text-[12px] bg-slate-800 hover:bg-slate-700 text-white px-3 py-1 rounded">{t('wallet.close')}</button>
            </div>
          )}
          {depositStatus === 'failed' && (
            <div className="flex flex-col items-center gap-2 px-1">
              <div className="text-[12px] font-bold text-center">{t('wallet.depositConfirmFailed')}</div>
              {depositFailureMessage ? (
                <div className="text-[11px] text-center leading-snug opacity-95 max-w-md">{depositFailureMessage}</div>
              ) : (
                <div className="text-[11px] text-center opacity-90">{t('wallet.tryAgainOrExplorer')}</div>
              )}
              <button onClick={onCloseDepositStatus} className="text-[12px] bg-slate-800 hover:bg-slate-700 text-white px-3 py-1 rounded">{t('wallet.close')}</button>
            </div>
          )}
        </div>
      )}

      <div className="bg-slate-50 dark:bg-slate-950/50 p-3 rounded border border-slate-200 dark:border-slate-800">
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">{t('wallet.depositNetwork')}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'polygon', name: 'Polygon', color: 'bg-orange-500', border: 'border-orange-500/50', text: 'text-orange-500' },
              { id: 'bnb', name: 'BNB Chain', color: 'bg-yellow-500', border: 'border-yellow-500/50', text: 'text-yellow-500' },
              { id: 'base', name: 'Base', color: 'bg-amber-500', border: 'border-amber-500/50', text: 'text-amber-500' }
            ].filter(net => {
              if (net.id === 'polygon') return !polyDepositOff;
              if (net.id === 'bnb') return !bnbDepositOff;
              if (net.id === 'base') return !baseDepositOff;
              return true;
            }).map((net) => (
              <button
                key={net.id}
                onClick={() => setSelectedNetwork(net.id as any)}
                className={`flex flex-col items-center justify-center p-2 rounded-lg border-2 transition-all ${selectedNetwork === net.id
                  ? `${net.border} ${net.color} text-white shadow-lg`
                  : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-400 hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
              >
                <div className={`w-2 h-2 rounded-full mb-1 ${selectedNetwork === net.id ? 'bg-white' : net.color}`}></div>
                <span className="text-[10px] font-bold uppercase">{net.name}</span>
              </button>
            ))}
          </div>
          {allDepositNetworksDisabled && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-2 text-center leading-snug">
              Depósitos USDC estão desativados em todas as redes (configuração do servidor).
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            maxLength={24}
            placeholder="0.00"
            value={usdcAmount}
            onChange={(e) => {
              const t = e.target.value.replace(/[^\d.,]/g, '');
              setUsdcAmount(t);
              if (depositFieldError) setDepositFieldError('');
            }}
            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-green-500 outline-none font-mono transition-colors"
          />
          <button
            onClick={handleDeposit}
            disabled={(() => {
              if (!hasWallet || !usdcAmount || allDepositNetworksDisabled || selectedDepositBlocked) return true;
              const v = parseFloat(usdcAmount.replace(/\s/g, '').replace(',', '.'));
              const minD = typeof minDepositUsdc === 'number' && Number.isFinite(minDepositUsdc) ? minDepositUsdc : 0.001;
              return !Number.isFinite(v) || v < minD || v > MAX_USDC_DEPOSIT_UI;
            })()}
            className="bg-green-100 dark:bg-green-900/30 hover:bg-green-200 dark:hover:bg-green-900/50 border border-green-300 dark:border-green-800 text-green-700 dark:text-green-400 text-xs font-bold px-4 rounded transition-colors"
          >
            ENVIAR USDC
          </button>
        </div>
        {!hasWallet && (
          <p className="text-[10px] text-red-600 dark:text-red-400 mt-1">{t('wallet.connectWalletToCredit')}</p>
        )}
        {depositFieldError && (
          <p className="text-[10px] text-red-600 dark:text-red-400 mt-1">{depositFieldError}</p>
        )}
        <p className="text-[10px] text-slate-500 dark:text-slate-600 mt-2 italic flex items-center gap-2">
          <Shield size={10} className="text-green-500" /> Liquidação automática via contrato inteligente.
        </p>

        {hasWallet && userEmail && onVerifyDepositByHash && (
          <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-wide">
              Já enviou USDC e o saldo não atualizou?
            </span>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('wallet.pasteTxHash')}
                value={manualTxHash}
                onChange={(e) => setManualTxHash(e.target.value)}
                className="w-full flex-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-[11px] font-mono text-slate-900 dark:text-white"
              />
              <button
                type="button"
                disabled={manualVerifyBusy || !manualTxHash || allDepositNetworksDisabled || selectedDepositBlocked}
                onClick={async () => {
                  if (!onVerifyDepositByHash) return;
                  setManualVerifyBusy(true);
                  try {
                    const r = await onVerifyDepositByHash(manualTxHash.trim(), selectedNetwork);
                    if (r.ok) {
                      setManualTxHash('');
                      alert(t('wallet.balanceUpdatedOk'));
                    } else if (r.pending) {
                      alert(
                        'O servidor ainda não obteve o recibo da rede (RPC). Se o explorer já mostra «sucesso», espera ~30 s e volta a validar; confirma também a «Rede da entrada» certa (Polygon / BNB / Base).'
                      );
                    } else {
                      alert(r.error || 'Não foi possível validar.');
                    }
                  } finally {
                    setManualVerifyBusy(false);
                  }
                }}
                className="shrink-0 text-[11px] font-bold bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-100 px-3 py-1.5 rounded disabled:opacity-40"
              >
                {manualVerifyBusy ? '…' : 'Validar hash'}
              </button>
            </div>
            <p className="text-[9px] text-slate-500 dark:text-slate-500">
              Usa a rede selecionada em «Rede da entrada». O envio tem de ser da carteira ligada no perfil para o endereço de depósito do jogo. Copia o hash pelo botão «Copy» do explorador — um só carácter errado (ex.:{' '}
              <span className="font-mono">8</span> em vez de <span className="font-mono">B</span>) invalida a transação.
            </p>
          </div>
        )}
      </div>

      <div className="bg-slate-50 dark:bg-slate-950/50 p-3 rounded border border-slate-200 dark:border-slate-800">
        <div className="flex flex-wrap justify-between items-center gap-2 mb-2">
          <span className="text-xs text-amber-600 dark:text-amber-500 font-bold flex items-center gap-1">
            <Upload size={12} /> Sacar cripto minerada
          </span>
          <span
            className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded border ${
              selectedMatching
                ? 'border-emerald-600/50 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                : 'border-slate-500/40 text-slate-500 dark:text-slate-400'
            }`}
          >
            {selectedMatching ? t('wallet.withdrawAvailable') : t('wallet.withdrawUnavailable')}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-center">
          <div className="flex min-w-0 items-center gap-2">
            {selectedCoin ? (
              <MiningCoinGlyph
                coin={{ id: selectedCoin.id, name: selectedCoin.name, symbol: selectedCoin.symbol }}
                size={22}
              />
            ) : null}
            <select
              value={selectedCoinId}
              onChange={(e) => setSelectedCoinId(e.target.value)}
              className="w-full min-w-0 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-3 py-2 text-sm text-slate-900 dark:text-white"
            >
              {miningCoins.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="text-[12px] text-slate-500 dark:text-slate-400 font-mono">
            Saldo on-chain: {formatAmount(coinBalances[selectedCoinId] || 0)}
          </div>
          <div className="text-[10px] text-slate-500 dark:text-slate-400 font-mono flex items-center gap-1 justify-end">
            <TrendingUp size={10} /> {formatAmount(coinRates[selectedCoinId] || 0)}/s
          </div>
        </div>
        <div className="flex gap-2 mt-2 items-stretch">
          <div className="relative flex-1">
            <input
              type="number"
              placeholder={`0.00`}
              min={0}
              value={coinAmount}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setCoinAmount(isNaN(v) ? e.target.value : String(Math.max(0, v)));
              }}
              className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-amber-500 outline-none font-mono transition-colors"
            />
            {Number(selectedMatching?.feePercent) > 0 && parseFloat(coinAmount) > 0 ? (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                <span className="text-[9px] font-bold text-red-500 bg-red-100 dark:bg-red-900/30 px-1 rounded">
                  -{selectedMatching?.feePercent}%
                </span>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleUseMaxBalance}
            disabled={!hasWallet || !(selectedBalance > 0)}
            className="text-[10px] font-bold uppercase tracking-wider bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 px-3 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label={t('wallet.useMaxBalance')}
            title={t('wallet.fillAvailableBalance')}
          >
            Máx
          </button>
        </div>
        {(() => {
          const c = miningCoins.find((x) => x.id === selectedCoinId);
          const m = findWithdrawTokenCfg(withdrawTokens, c);
          const minW = c && m ? minimumWithdrawCryptoAmount(c, m) : 0;
          const amtNum = parseFloat(coinAmount);
          const feePercent = Number(m?.feePercent) || 0;
          const feeAmount = !isNaN(amtNum) ? (amtNum * feePercent) / 100 : 0;
          const netAmount = !isNaN(amtNum) ? Math.max(0, amtNum - feeAmount) : 0;

          return (
            <div className="mt-2 space-y-1">
              <p className="text-[9px] text-slate-500 px-1 leading-snug">
                Indica o <span className="font-bold text-slate-600 dark:text-slate-300">valor bruto</span> a debitar do saldo minerado; a taxa é descontada do que recebes na carteira.
              </p>
              <div className="flex justify-between px-1">
                <span className="text-[9px] text-slate-500 font-bold uppercase">
                  {minW > 0 ? `Mínimo bruto: ${formatAmount(minW)} ${c?.symbol}` : ''}
                </span>
                {feePercent > 0 ? (
                  <span className="text-[9px] text-red-500 font-bold uppercase">Taxa: {feePercent}%</span>
                ) : null}
              </div>

              {!isNaN(amtNum) && amtNum > 0 && (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded p-2 text-[10px] space-y-1 animate-in fade-in zoom-in-95 duration-200">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400">{t('wallet.grossValueColon')}</span>
                    <span className="text-slate-600 dark:text-slate-300 font-mono">{formatAmount(amtNum)} {c?.symbol}</span>
                  </div>
                  {feePercent > 0 ? (
                    <div className="flex justify-between items-center text-red-500">
                      <span>TAXA ({feePercent}%):</span>
                      <span className="font-mono">-{formatAmount(feeAmount)} {c?.symbol}</span>
                    </div>
                  ) : null}
                  <div className="flex justify-between items-center font-black pt-1 border-t border-slate-100 dark:border-slate-800">
                    <span className="text-amber-600 dark:text-amber-400">{t('wallet.youReceiveColon')}</span>
                    <span className="text-amber-600 dark:text-amber-400 font-mono text-xs">{formatAmount(netAmount)} {c?.symbol}</span>
                  </div>
                  <div className="pt-1 flex items-center gap-1 text-[8px] text-amber-600 dark:text-amber-500 font-bold uppercase tracking-tighter">
                    <Clock size={10} /> O saque será confirmado em até 24 horas
                  </div>
                </div>
              )}
            </div>
          );
        })()}
        <div className="flex gap-2 mt-2">
          <button
            type="button"
            onClick={openWithdrawConfirm}
            disabled={!withdrawCanSubmit || withdrawBusy}
            className="bg-amber-100 dark:bg-amber-900/30 hover:bg-amber-200 dark:hover:bg-amber-900/50 border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs font-bold px-4 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed h-9 inline-flex items-center gap-2"
          >
            {withdrawBusy ? 'A ENVIAR…' : 'SACAR'}
          </button>
        </div>
        {withdrawDisabledReason ? (
          <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-1 leading-snug">{withdrawDisabledReason}</p>
        ) : null}
        <p className="text-[10px] text-slate-500 dark:text-slate-600 mt-2 italic flex items-center gap-1">
          <HardDrive size={10} /> O valor sai do saldo minerado do ativo selecionado.
        </p>
      </div>

      <div className="bg-slate-50 dark:bg-slate-950/50 p-3 rounded border border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-2 mb-2">
          <Coins size={12} className="text-orange-600 dark:text-orange-400" />
          <span className="text-xs text-slate-700 dark:text-slate-300 font-bold">{t('wallet.miningAssets')}</span>
        </div>
        <div className="space-y-1">
          {miningCoins.length === 0 ? (
            <div className="text-[12px] text-slate-500">{t('wallet.noActivePairs')}</div>
          ) : miningCoins.map(c => (
            <div key={c.id} className="flex items-center justify-between gap-2 text-[12px] font-mono">
              <span className="flex min-w-0 items-center gap-2 text-slate-600 dark:text-slate-300">
                <MiningCoinGlyph coin={{ id: c.id, name: c.name, symbol: c.symbol }} size={18} />
                <span className="truncate">{c.name}</span>
              </span>
              <span className="shrink-0 text-amber-700 dark:text-amber-300">{formatAmount(coinRates[c.id] || 0)}/s</span>
            </div>
          ))}
        </div>
      </div>

      {withdrawConfirm ? (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t('wallet.confirmWithdraw')}
          onClick={() => setWithdrawConfirm(null)}
        >
          <div
            className="relative w-full max-w-md rounded-2xl border border-amber-600/60 bg-slate-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 pr-8 text-base font-black uppercase tracking-wide text-white">{t('wallet.confirmWithdraw')}</h3>
            <p className="text-sm text-slate-300">
              Sacar <span className="font-bold text-white">{formatAmount(withdrawConfirm.amount)} {withdrawConfirm.symbol}</span> do saldo minerado?
            </p>
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-400">{t('wallet.grossLabel')}</span>
                <span className="font-mono text-slate-200">{formatAmount(withdrawConfirm.amount)} {withdrawConfirm.symbol}</span>
              </div>
              {withdrawConfirm.feePercent > 0 ? (
                <div className="flex justify-between text-red-400">
                  <span>Taxa ({withdrawConfirm.feePercent}%):</span>
                  <span className="font-mono">-{formatAmount(withdrawConfirm.fee)} {withdrawConfirm.symbol}</span>
                </div>
              ) : null}
              <div className="flex justify-between border-t border-slate-800 pt-1 font-bold">
                <span className="text-amber-400">{t('wallet.youReceive')}</span>
                <span className="font-mono text-amber-400">{formatAmount(withdrawConfirm.net)} {withdrawConfirm.symbol}</span>
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
              O processamento pode levar até 24 horas na sua carteira conectada.
            </p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setWithdrawConfirm(null)}
                disabled={withdrawBusy}
                className="w-full rounded-xl border border-slate-600 bg-slate-800 py-2.5 text-xs font-black uppercase tracking-widest text-slate-200 transition hover:bg-slate-700 disabled:opacity-60 disabled:cursor-not-allowed sm:w-auto sm:min-w-[140px]"
              >
                {t('wallet.cancel')}
              </button>
              <button
                type="button"
                onClick={() => { void submitWithdrawRequest(); }}
                disabled={withdrawBusy}
                className="w-full rounded-xl bg-amber-500 py-2.5 text-xs font-black uppercase tracking-widest text-slate-950 transition hover:bg-amber-400 disabled:opacity-60 disabled:cursor-not-allowed sm:w-auto sm:min-w-[180px]"
              >
                {withdrawBusy ? '…' : t('wallet.confirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <UiNoticeModal notice={withdrawNotice} onClose={() => setWithdrawNotice(null)} overlayZClassName="z-[155]" />

    </div>
  );
};
