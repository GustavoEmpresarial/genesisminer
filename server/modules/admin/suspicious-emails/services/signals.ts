/**
 * Motivos derivados de dados reais da BD (sem chamadas externas).
 * Migrado de legacy/backend/modules/admin/suspiciousEmails/suspiciousUserSignals.ts (verbatim).
 */
import { MS_PER_DAY } from '../../../../shared/utils/time.js';
import type { SuspiciousEmailReasonCode } from './detect.js';

export type UserActivitySignals = {
  coinBalanceSum: number;
  racksMiningOn: number;
  rackCount: number;
  hasStock: boolean;
  totalUsdcDeposited: number;
  hasWallet: boolean;
  referredBy: string | null;
  lastLoginMs: number | null;
  /** `game_states.start_time` em ms ou null. */
  accountStartMs: number | null;
  lastCheckinMs: number | null;
};

const EPS_COIN = 1e-8;
const EPS_DEP = 1e-6;
const INACTIVE_DAYS = 90;
const INACTIVE_MS = INACTIVE_DAYS * MS_PER_DAY;
const NO_LOGIN_GRACE_DAYS = 30;
const NO_LOGIN_GRACE_MS = NO_LOGIN_GRACE_DAYS * MS_PER_DAY;

function pushUnique(arr: SuspiciousEmailReasonCode[], r: SuspiciousEmailReasonCode) {
  if (!arr.includes(r)) arr.push(r);
}

/**
 * Deriva razões de suspeita a partir de sinais reais de actividade em jogo
 * (mineração, wallet, depósito, progresso, último login) — não depende do
 * formato do email.
 *
 * `totalHashFromSnapshot`: hash total real (de
 * `computePlayerGameHeaderSnapshot`), ou `null` quando não foi calculado
 * (chamador optou por não pagar o custo — ver nota em
 * `resolveSuspiciousUsersWorkingSet`). Quando fornecido e `> 0`, tem
 * prioridade sobre a aproximação por saldo/racks para decidir `mined`; quando
 * `null`, cai para a aproximação (`coinBalanceSum > 0` ou `racksMiningOn > 0`).
 * Isto pode fazer um jogador que já minerou (hash > 0) mas gastou o saldo e
 * desligou os racks aparecer como `never_mined`/`zero_hash` quando chamado
 * sem snapshot — só é preciso quando `totalHashFromSnapshot` vem preenchido.
 *
 * @returns Lista de `SuspiciousEmailReasonCode` ligados a actividade
 *   (`never_mined`, `zero_hash`, `no_wallet`, `no_deposit`, `referral_only`,
 *   `inactive_account`, `no_game_progress`, `dead_account`), sem duplicados.
 */
export function deriveActivityReasons(sig: UserActivitySignals, totalHashFromSnapshot: number | null): SuspiciousEmailReasonCode[] {
  const out: SuspiciousEmailReasonCode[] = [];

  const hashKnown = totalHashFromSnapshot != null && Number.isFinite(totalHashFromSnapshot);
  const effectiveHash = hashKnown ? Math.max(0, totalHashFromSnapshot as number) : null;

  const minedByCoins = sig.coinBalanceSum > EPS_COIN;
  const minedByRacks = sig.racksMiningOn > 0;
  const mined = (effectiveHash != null && effectiveHash > EPS_COIN) || minedByCoins || minedByRacks;

  if (!mined) {
    pushUnique(out, 'never_mined');
    if (effectiveHash != null && effectiveHash <= EPS_COIN) {
      pushUnique(out, 'zero_hash');
    } else if (!hashKnown && !minedByCoins && !minedByRacks) {
      pushUnique(out, 'zero_hash');
    }
  }

  if (!sig.hasWallet) {
    pushUnique(out, 'no_wallet');
  }

  if (sig.totalUsdcDeposited <= EPS_DEP) {
    pushUnique(out, 'no_deposit');
  }

  const ref = (sig.referredBy || '').trim();
  if (ref && !mined && !sig.hasWallet && sig.totalUsdcDeposited <= EPS_DEP) {
    pushUnique(out, 'referral_only');
  }

  const now = Date.now();
  if (sig.lastLoginMs != null && now - sig.lastLoginMs > INACTIVE_MS) {
    pushUnique(out, 'inactive_account');
  } else if (sig.lastLoginMs == null && sig.accountStartMs != null && now - sig.accountStartMs > NO_LOGIN_GRACE_MS) {
    pushUnique(out, 'inactive_account');
  }

  const noProgress =
    sig.rackCount === 0 && !sig.hasStock && sig.coinBalanceSum <= EPS_COIN && sig.totalUsdcDeposited <= EPS_DEP && (sig.lastCheckinMs == null || Number(sig.lastCheckinMs) <= 0);
  if (noProgress && !mined) {
    pushUnique(out, 'no_game_progress');
  }

  const inactive = (sig.lastLoginMs != null && now - sig.lastLoginMs > INACTIVE_MS) || (sig.lastLoginMs == null && sig.accountStartMs != null && now - sig.accountStartMs > NO_LOGIN_GRACE_MS);

  if (!mined && !sig.hasWallet && sig.totalUsdcDeposited <= EPS_DEP && inactive && noProgress) {
    pushUnique(out, 'dead_account');
  }

  return out;
}

/** Combina razões de email (`detectSuspiciousEmail`) com razões de actividade (`deriveActivityReasons`), sem duplicados, preservando a ordem (email primeiro). */
export function mergeEmailAndActivityReasons(emailReasons: SuspiciousEmailReasonCode[], sig: UserActivitySignals, totalHashFromSnapshot: number | null): SuspiciousEmailReasonCode[] {
  const act = deriveActivityReasons(sig, totalHashFromSnapshot);
  const merged: SuspiciousEmailReasonCode[] = [];
  for (const r of emailReasons) {
    if (!merged.includes(r)) merged.push(r);
  }
  for (const r of act) {
    if (!merged.includes(r)) merged.push(r);
  }
  return merged;
}
