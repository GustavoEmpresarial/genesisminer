/**
 * Helpers de yield/histórico + `computeProgressForUser`.
 * Crédito I/O em prod: `genesis-mining-worker` via `callMiningWorkerProgress`.
 * Catch-up = snapshot actual (não replay físico). Histórico canónico:
 * 1 row por `(user_id, coin_id, window_start_ms, window_end_ms)`.
 */
import type { Pool } from 'pg';
import { sanitizeForLog } from '../../../shared/utils/safe-text.js';
import { parseFiniteNumberLenient } from './mining-numeric.js';
import { amountsAlmostEqual, assertAmountsAlmostEqual } from './mining-economic-epsilon.js';
import { listCreditHistoryWindows, TEN_MIN_MS } from './wall-clock-grid.js';
import {
  rustAssertTickHistoryMatchesEconomy,
  rustBuildMiningBlockHistoryRowsForCredit,
  rustCalculateIntegratedYield,
  rustConsolidateMiningBlockHistoryRows
} from './mining-rust-bridge.js';
import { callMiningWorkerProgress } from './mining-worker-client.js';
import { MS_PER_SECOND } from '../../../shared/utils/time.js';

const LOG_PREFIX = '[MiningProgress]';
const LOG_UID_MAX_LENGTH = 48;

const activeProgressCalculations = 0;

export function getActiveMiningProgressCalculations(): number {
  return activeProgressCalculations;
}

type YieldHistRow = { coin_id: string; yield_per_hash: unknown; effective_at: unknown };
export type MiningBlockHistoryInsertRow = {
  coinId: string;
  roomId: string | null;
  windowStartMs: number;
  windowEndMs: number;
  creditBlocks: number;
  amountCoins: number;
  amountUsd: number;
  userHashHps: number;
  networkHashrate: number;
  blockReward: number;
  blockTime: number;
};

export function calculateIntegratedYield(_coinId: string, startTimeMs: number, endTimeMs: number, sortedCoinHistory: YieldHistRow[] | undefined): number {
  const rust = rustCalculateIntegratedYield(startTimeMs, endTimeMs, sortedCoinHistory);
  if (rust != null && Number.isFinite(rust)) return rust;

  if (endTimeMs <= startTimeMs) return 0;
  if (!sortedCoinHistory || sortedCoinHistory.length === 0) return 0;

  const coinHistory = sortedCoinHistory;
  let totalYield = 0;
  let cursor = startTimeMs;

  let currentRate = parseFiniteNumberLenient(coinHistory[0]?.yield_per_hash, 'yield_hist.head');

  for (const h of coinHistory) {
    const effAt = parseFiniteNumberLenient(h.effective_at, 'yield_hist.effective_at');
    if (effAt <= startTimeMs) {
      currentRate = parseFiniteNumberLenient(h.yield_per_hash, 'yield_hist.rate');
    } else {
      break;
    }
  }

  for (const h of coinHistory) {
    const eff = parseFiniteNumberLenient(h.effective_at, 'yield_hist.effective_at');
    if (eff > startTimeMs && eff < endTimeMs) {
      const durationSec = (eff - cursor) / MS_PER_SECOND;
      totalYield += durationSec * currentRate;
      cursor = eff;
      currentRate = parseFiniteNumberLenient(h.yield_per_hash, 'yield_hist.rate');
    }
  }

  const durationSec = (endTimeMs - cursor) / MS_PER_SECOND;
  totalYield += durationSec * currentRate;

  return Number.isFinite(totalYield) ? totalYield : 0;
}

/**
 * Materializa linhas de histórico por janela canónica para UM crédito de slot/rack×coin.
 * O crédito económico do tick continua no intervalo completo — isto só espelha o histórico.
 *
 * Várias contribuições (racks/ASICs) devem ser consolidadas com
 * `consolidateMiningBlockHistoryRows` antes do INSERT (1 row por user×coin×janela).
 *
 * `useHistoryIntegration` deve espelhar o modo do saldo (`historyYield > 0`).
 */
export function buildMiningBlockHistoryRowsForCredit(opts: {
  coinId: string;
  roomId: string | null;
  intervalStartMs: number;
  intervalEndMs: number;
  sortedCoinHistory: YieldHistRow[] | undefined;
  useHistoryIntegration: boolean;
  fallbackYieldPerHash: number;
  effectiveHash: number;
  usdRate: number;
  networkHashrate: number;
  blockReward: number;
  blockTime: number;
}): MiningBlockHistoryInsertRow[] {
  const rust = rustBuildMiningBlockHistoryRowsForCredit(opts);
  if (rust != null) return rust as MiningBlockHistoryInsertRow[];

  const windows = listCreditHistoryWindows(opts.intervalStartMs, opts.intervalEndMs);
  const out: MiningBlockHistoryInsertRow[] = [];
  for (const w of windows) {
    const windowYield = opts.useHistoryIntegration
      ? calculateIntegratedYield(opts.coinId, w.startMs, w.endMs, opts.sortedCoinHistory)
      : opts.fallbackYieldPerHash * ((w.endMs - w.startMs) / MS_PER_SECOND);
    const amountCoins = opts.effectiveHash * windowYield;
    if (!(Number.isFinite(amountCoins) && amountCoins > 0)) continue;
    const amountUsd = amountCoins * opts.usdRate;
    const dur = w.endMs - w.startMs;
    const creditBlocks = dur === TEN_MIN_MS ? 1 : Math.max(1, Math.round(dur / TEN_MIN_MS));
    out.push({
      coinId: opts.coinId,
      roomId: opts.roomId,
      windowStartMs: w.startMs,
      windowEndMs: w.endMs,
      creditBlocks,
      amountCoins,
      amountUsd: Number.isFinite(amountUsd) ? amountUsd : 0,
      userHashHps: opts.effectiveHash,
      networkHashrate: opts.networkHashrate,
      blockReward: opts.blockReward,
      blockTime: opts.blockTime
    });
  }
  return out;
}

function historyCanonicalKey(r: Pick<MiningBlockHistoryInsertRow, 'coinId' | 'windowStartMs' | 'windowEndMs'>): string {
  return `${r.coinId}\0${Math.floor(r.windowStartMs)}\0${Math.floor(r.windowEndMs)}`;
}

/**
 * Consolida contribuições rack/slot na identidade histórica canónica:
 * `(coin_id, window_start_ms, window_end_ms)` → 1 row (user implícito no INSERT).
 *
 * - `amount_coins` / `amount_usd` / `user_hash_hps` = SUM
 * - `credit_blocks` = MAX (mesmo segmento; NÃO somar)
 * - `room_id`: mantém se todas iguais; senão `null` (múltiplas salas)
 */
export function consolidateMiningBlockHistoryRows(rows: MiningBlockHistoryInsertRow[]): MiningBlockHistoryInsertRow[] {
  const rust = rustConsolidateMiningBlockHistoryRows(rows);
  if (rust != null) return rust as MiningBlockHistoryInsertRow[];

  if (rows.length <= 1) return rows;
  const byKey = new Map<
    string,
    MiningBlockHistoryInsertRow & { _roomSet: Set<string> }
  >();
  for (const r of rows) {
    const key = historyCanonicalKey(r);
    const room = r.roomId != null && String(r.roomId).trim() ? String(r.roomId).trim() : '';
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...r,
        roomId: room || null,
        amountCoins: Number(r.amountCoins) || 0,
        amountUsd: Number(r.amountUsd) || 0,
        userHashHps: Number(r.userHashHps) || 0,
        creditBlocks: Math.max(1, Math.floor(Number(r.creditBlocks) || 1)),
        _roomSet: new Set(room ? [room] : [])
      });
      continue;
    }
    existing.amountCoins += Number(r.amountCoins) || 0;
    existing.amountUsd += Number(r.amountUsd) || 0;
    existing.userHashHps += Number(r.userHashHps) || 0;
    existing.creditBlocks = Math.max(existing.creditBlocks, Math.max(1, Math.floor(Number(r.creditBlocks) || 1)));
    if (Number.isFinite(r.networkHashrate) && r.networkHashrate > existing.networkHashrate) {
      existing.networkHashrate = r.networkHashrate;
    }
    if (Number.isFinite(r.blockReward)) existing.blockReward = r.blockReward;
    if (Number.isFinite(r.blockTime)) existing.blockTime = r.blockTime;
    if (room) existing._roomSet.add(room);
  }
  const out: MiningBlockHistoryInsertRow[] = [];
  for (const agg of byKey.values()) {
    const rooms = [...agg._roomSet];
    out.push({
      coinId: agg.coinId,
      roomId: rooms.length === 1 ? rooms[0]! : null,
      windowStartMs: Math.floor(agg.windowStartMs),
      windowEndMs: Math.floor(agg.windowEndMs),
      creditBlocks: agg.creditBlocks,
      amountCoins: agg.amountCoins,
      amountUsd: agg.amountUsd,
      userHashHps: agg.userHashHps,
      networkHashrate: agg.networkHashrate,
      blockReward: agg.blockReward,
      blockTime: agg.blockTime
    });
  }
  out.sort((a, b) => a.windowStartMs - b.windowStartMs || a.windowEndMs - b.windowEndMs || a.coinId.localeCompare(b.coinId));
  return out;
}

/** Chave canónica já existe com payload económico incompatível (fora do epsilon). */
export class MiningBlockHistoryMismatchError extends Error {
  readonly code = 'MINING_BLOCK_HISTORY_MISMATCH';
  constructor(
    readonly detail: {
      userId: number;
      coinId: string;
      windowStartMs: number;
      windowEndMs: number;
      existingAmount: number;
      incomingAmount: number;
    }
  ) {
    super(
      `mining_block_history mismatch user=${detail.userId} coin=${detail.coinId} ` +
        `window=[${detail.windowStartMs},${detail.windowEndMs}) ` +
        `existing=${detail.existingAmount} incoming=${detail.incomingAmount}`
    );
    this.name = 'MiningBlockHistoryMismatchError';
  }
}

/**
 * Janela canónica já creditada em `mining_block_history` (amounts ≈ iguais).
 * Abort sem `coin_balances +=` — history `ON CONFLICT DO NOTHING` não impede double-credit.
 */
export class MiningBlockHistoryAlreadyCreditedError extends Error {
  readonly code = 'MINING_BLOCK_HISTORY_ALREADY_CREDITED';
  constructor(
    readonly detail: {
      userId: number;
      coinId: string;
      windowStartMs: number;
      windowEndMs: number;
      existingAmount: number;
      incomingAmount: number;
    }
  ) {
    super(
      `mining_block_history already credited user=${detail.userId} coin=${detail.coinId} ` +
        `window=[${detail.windowStartMs},${detail.windowEndMs}) ` +
        `existing=${detail.existingAmount} incoming=${detail.incomingAmount} — abort sem += balances`
    );
    this.name = 'MiningBlockHistoryAlreadyCreditedError';
  }
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> };

/**
 * Se já existir row canónica para a mesma chave:
 * - amount fora do epsilon → `MiningBlockHistoryMismatchError` (TX ROLLBACK)
 * - amount dentro do epsilon → `MiningBlockHistoryAlreadyCreditedError` (TX ROLLBACK;
 *   evita `coin_balances +=` enquanto history faz DO NOTHING)
 * Sem row existente → ok (crédito novo).
 */
export async function assertCanonicalHistoryCompatible(
  client: Queryable,
  userId: number,
  rows: MiningBlockHistoryInsertRow[]
): Promise<void> {
  if (rows.length === 0) return;
  const res = await client.query(
    `SELECT h.coin_id, h.window_start_ms, h.window_end_ms, h.amount_coins
       FROM mining_block_history h
       INNER JOIN unnest($2::text[], $3::bigint[], $4::bigint[]) AS v(coin_id, window_start_ms, window_end_ms)
         ON h.coin_id = v.coin_id
        AND h.window_start_ms = v.window_start_ms
        AND h.window_end_ms = v.window_end_ms
      WHERE h.user_id = $1`,
    [
      userId,
      rows.map((r) => r.coinId),
      rows.map((r) => Math.floor(r.windowStartMs)),
      rows.map((r) => Math.floor(r.windowEndMs))
    ]
  );
  if (!res.rows.length) return;
  const incoming = new Map<string, number>();
  for (const r of rows) {
    incoming.set(`${r.coinId}\0${Math.floor(r.windowStartMs)}\0${Math.floor(r.windowEndMs)}`, Number(r.amountCoins) || 0);
  }
  for (const row of res.rows) {
    const coinId = String(row.coin_id);
    const ws = Math.floor(Number(row.window_start_ms));
    const we = Math.floor(Number(row.window_end_ms));
    const key = `${coinId}\0${ws}\0${we}`;
    const existingAmount = Number(row.amount_coins) || 0;
    const incomingAmount = incoming.get(key);
    if (incomingAmount == null) continue;
    const detail = {
      userId,
      coinId,
      windowStartMs: ws,
      windowEndMs: we,
      existingAmount,
      incomingAmount
    };
    if (!amountsAlmostEqual(existingAmount, incomingAmount)) {
      throw new MiningBlockHistoryMismatchError(detail);
    }
    throw new MiningBlockHistoryAlreadyCreditedError(detail);
  }
}

/** Σ history consolidado por coin ≡ totalGained (± epsilon). */
export function assertTickHistoryMatchesEconomy(
  totalGained: Map<string, number>,
  historyRows: MiningBlockHistoryInsertRow[]
): void {
  const rustOk = rustAssertTickHistoryMatchesEconomy(totalGained, historyRows);
  if (rustOk === true) return;

  const histByCoin = new Map<string, number>();
  for (const r of historyRows) {
    histByCoin.set(r.coinId, (histByCoin.get(r.coinId) || 0) + (Number(r.amountCoins) || 0));
  }
  const coins = new Set([...totalGained.keys(), ...histByCoin.keys()]);
  for (const coinId of coins) {
    assertAmountsAlmostEqual(totalGained.get(coinId) || 0, histByCoin.get(coinId) || 0, `tick economy↔history coin=${coinId}`);
  }
}

export type ComputeProgressResult = {
  ok: boolean;
  offlineMined?: Record<string, number>;
  error?: string;
  /** true quando o tick pesado foi saltado (poll recente/throttle). */
  skippedRecent?: boolean;
};

/** Fault injection só para testes de atomicidade (staging). Nunca em produção. */
export type ComputeProgressFaultHooks = {
  afterLedger?: () => void | Promise<void>;
  afterBalances?: () => void | Promise<void>;
  afterHistory?: () => void | Promise<void>;
  afterLastUpdated?: () => void | Promise<void>;
  beforeCommit?: () => void | Promise<void>;
};

export type ComputeProgressOptions = {
  /**
   * Se > 0, não recalcula se o último tick (memória ou `last_updated_at`) foi há menos de N ms.
   * Usar em GET/poll; **não** em save/compra (crédito tem de correr).
   */
  skipIfRecentMs?: number;
  /** Fault hooks — apenas testes. */
  faultHooks?: ComputeProgressFaultHooks;
};

/** Último tick bem-sucedido neste processo (anti-storm em GET). */
const progressTickAtByUid = new Map<number, number>();

function resolveUserId(uid: unknown): number | null {
  const n = typeof uid === 'number' ? uid : parseInt(String(uid), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function computeProgressForUser(
  _pool: Pool,
  uid: unknown,
  _nowArg: unknown,
  updateTimestamp = true,
  opts?: ComputeProgressOptions
): Promise<ComputeProgressResult> {
  if (!updateTimestamp) return { ok: true };

  const userId = resolveUserId(uid);
  if (!userId) {
    console.warn(`${LOG_PREFIX} user id inválido: %s`, sanitizeForLog(String(uid), LOG_UID_MAX_LENGTH));
    return { ok: false, error: 'invalid user' };
  }

  if (String(process.env.MINING_PROGRESS_COMPUTE_ENABLED ?? '1').trim() === '0') {
    console.log(`${LOG_PREFIX} user=%s compute desligado (MINING_PROGRESS_COMPUTE_ENABLED=0)`, userId);
    return { ok: true };
  }

  const skipIfRecentMs = Math.max(0, Math.floor(Number(opts?.skipIfRecentMs) || 0));
  if (skipIfRecentMs > 0) {
    const memAt = progressTickAtByUid.get(userId) || 0;
    const wallNow = Date.now();
    if (memAt > 0 && wallNow - memAt < skipIfRecentMs) {
      return { ok: true, offlineMined: {}, skippedRecent: true };
    }
  }
  const workerResult = await callMiningWorkerProgress(userId);
  if (workerResult.ok && !workerResult.skippedRecent) {
    progressTickAtByUid.set(userId, Date.now());
  }
  return workerResult;
}
