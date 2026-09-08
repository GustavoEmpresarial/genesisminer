/**
 * Job em background: yield global por moeda + stats de ranking, a partir de um único
 * scan de racks/upgrades/slots/multipliers. Escreve `mining_yield_history` (grelha 10 min
 * UTC) e `app_cache.network_stats`.
 *
 * ⚠️ Corte de escopo: `enqueueGenesisJob` (fila BullMQ) não portado — `bullmq` não é
 * dependência de `current/server` (mesmo tratamento dado a `multer`/`sharp` noutros
 * módulos). `maybeSyncLiveUsdToMiningCoinsPostgres` (`lib/miningLivePrices.ts`, 248
 * linhas, só `.js`/`.d.ts` no legado — código-fonte TS já não existe no repo) também não
 * portado: enriquecimento cosmético de preço USD via CoinGecko, não afeta yield do jogo
 * (comentário do próprio arquivo original). Ambos os cortes são chamadas best-effort/
 * fire-and-forget no legado — a ausência não muda nenhum cálculo de yield.
 *
 * Migrado de legacy/backend/cron/miningYieldCron.ts.
 */
import type { PoolClient } from 'pg';
import pool from '../../../core/database/pool.js';
import { parseFiniteNumberLenient } from './mining-numeric.js';
import { sanitizeForLog } from '../../../shared/utils/safe-text.js';
import { miningRuntimeStats } from './runtime-stats.js';
import { setGlobalNetworkStats, type GlobalNetworkStatsState } from './global-stats-store.js';
import { getSocketIo } from '../../../core/socket/client.js';
import { type JobContext } from '../../../core/ops/job-runner.js';
import { log } from '../../../core/ops/logger.js';
import { miningTenMinuteGridEnabled, lastCompletedTenMinuteUtcGrid, listPendingTenMinuteBoundaries } from './wall-clock-grid.js';
import { creditCountsTowardGeneralPower, isIndependentNetworkPoolMiningCoinRef, listSlotMiningCredits, resolveNftAutoArmario1OnlyRoomIds, type UpgradeMiningRow } from './nft-room-mining.js';
import { resolveAsicRoomIds } from './room-kind.js';
import { MS_PER_HOUR } from '../../../shared/utils/time.js';
import { rustBuildYieldHistoryRowsForBoundary } from './mining-rust-bridge.js';
import { effectiveNetworkHashrateForCoin } from './network-hashrate.js';

const LOG_PREFIX = '[MiningYieldCron]';

const HISTORY_RETENTION_HOURS = 72;
/** Alinhado à retenção em mining_yield_history (server legado). */
const HISTORY_RETENTION_MS = HISTORY_RETENTION_HOURS * MS_PER_HOUR;
const SLOW_TICK_LOG_THRESHOLD_MS = 1500;
const BATCH_SIZE = 200;
const LOG_MSG_MAX_LEN = 200;
/**
 * Tecto por tick: ~12h de grelha. Catch-up maior continua no tick seguinte
 * (sem saltar — só amortiza duração sob o lock/timeout existentes).
 */
const MAX_YIELD_CATCHUP_BOUNDARIES_PER_TICK = 72;

/** Último `effective_at` de grelha 10 min UTC já gravado no histórico global (evita duplicar entre ticks do cron). */
let lastYieldHistoryBoundaryMs = 0;
/** Evita re-hidratar em cada tick; só falha silenciosamente até conseguir. */
let yieldHistoryBoundaryHydrated = false;

/** @internal vitest — reinicia checkpoint em memória entre testes. */
export function resetMiningYieldCronStateForTests(): void {
  lastYieldHistoryBoundaryMs = 0;
  yieldHistoryBoundaryHydrated = false;
}

/** @internal vitest. */
export function getMiningYieldHistoryBoundaryMsForTests(): number {
  return lastYieldHistoryBoundaryMs;
}

/** @internal vitest — simula checkpoint já hidratado (sem query). */
export function setMiningYieldHistoryBoundaryMsForTests(ms: number): void {
  lastYieldHistoryBoundaryMs = Number.isFinite(ms) && ms > 0 ? lastCompletedTenMinuteUtcGrid(ms) : 0;
  yieldHistoryBoundaryHydrated = true;
}

async function hydrateYieldHistoryBoundaryFromDb(c: PoolClient): Promise<void> {
  if (!miningTenMinuteGridEnabled() || yieldHistoryBoundaryHydrated) return;
  try {
    const r = await c.query(`SELECT (MAX(effective_at))::float8 AS m FROM mining_yield_history WHERE effective_at IS NOT NULL`);
    const raw = r.rows[0]?.m;
    const mx = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw);
    if (Number.isFinite(mx) && mx > 0) {
      lastYieldHistoryBoundaryMs = lastCompletedTenMinuteUtcGrid(mx);
    }
    yieldHistoryBoundaryHydrated = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`${LOG_PREFIX} hydrate yield boundary (re-tenta no próximo tick):`, sanitizeForLog(msg, LOG_MSG_MAX_LEN));
  }
}

function safeRollback(client: PoolClient): void {
  client.query('ROLLBACK').catch(() => {
    /* ignore */
  });
}

type RackRow = { selected_coin_id: string | null; id: string; user_id: number; item_id: string | null; battery_id: string; room_id: string | null; username: unknown };
type UserStat = { user_id: number; username: unknown; coins: Record<string, number>; generalPower: number };
type CoinYieldRow = {
  id: unknown;
  symbol?: unknown;
  nft_room_only?: unknown;
  nftRoomOnly?: unknown;
  block_reward: unknown;
  block_time: unknown;
  network_hashrate: unknown;
  independentPool?: boolean;
  independent_pool?: boolean;
};

/**
 * Monta linhas de `mining_yield_history` para um `effective_at` fixo.
 * Hashrate real = snapshot do tick actual (não há série histórica por boundary).
 */
export function buildYieldHistoryRowsForBoundary(
  coins: CoinYieldRow[],
  realNetworkHashratesMap: Map<string, number>,
  effectiveAtMs: number
): { coinIds: string[]; yields: number[]; rewards: number[]; netHashes: number[]; effectives: number[] } {
  const rust = rustBuildYieldHistoryRowsForBoundary(coins, realNetworkHashratesMap, effectiveAtMs);
  if (rust != null) return rust;

  const coinIds: string[] = [];
  const yields: number[] = [];
  const rewards: number[] = [];
  const netHashes: number[] = [];
  const effectives: number[] = [];

  // usd_month: SECONDS_PER_MONTH = 30 * 86400 ; DIST_MIN_HASHRATE = 10.
  // Mesma fórmula de rust/genesis-core/src/mining/yield_boundary.rs (usd_month_yield).
  const SECONDS_PER_MONTH = 30 * 86400;
  const DIST_MIN_HASHRATE = 10;
  const MIN_NETWORK_HASHRATE = 1;

  for (const coin of coins) {
    const coinId = String(coin.id);
    const realNetHash = realNetworkHashratesMap.get(coinId) || 0;

    const distributionMode =
      String((coin as { distribution_mode?: unknown }).distribution_mode ??
             (coin as { distributionMode?: unknown }).distributionMode ?? 'legacy').toLowerCase() === 'usd_month'
        ? 'usd_month'
        : 'legacy';
    if (distributionMode === 'usd_month') {
      const usdMonthRaw = Number((coin as { distribution_usd_month?: unknown }).distribution_usd_month ??
                                 (coin as { distributionUsdMonth?: unknown }).distributionUsdMonth);
      const usdMonth = Number.isFinite(usdMonthRaw) && usdMonthRaw > 0 ? usdMonthRaw : 0;
      const priceRaw = Number((coin as { price_usd?: unknown }).price_usd ??
                              (coin as { priceUsd?: unknown }).priceUsd);
      const priceOr1 = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : 1;
      const budgetPerSecCoins = usdMonth / SECONDS_PER_MONTH / priceOr1;
      const active = Number.isFinite(realNetHash) && realNetHash > 0 ? realNetHash : 0;
      const divisor = Math.max(active, DIST_MIN_HASHRATE);
      const yph = active <= MIN_NETWORK_HASHRATE || budgetPerSecCoins <= 0 ? 0 : budgetPerSecCoins / divisor;
      coinIds.push(coinId);
      yields.push(yph);
      rewards.push(budgetPerSecCoins);
      netHashes.push(divisor);
      effectives.push(effectiveAtMs);
      continue;
    }

    const blockReward = parseFiniteNumberLenient(coin.block_reward, `coin.${coinId}.block_reward`);
    const blockTime = parseFiniteNumberLenient(coin.block_time, `coin.${coinId}.block_time`);
    const networkHashrate = parseFiniteNumberLenient(coin.network_hashrate, `coin.${coinId}.network_hashrate`);
    const independentPool =
      coin.independentPool === true ||
      coin.independent_pool === true ||
      isIndependentNetworkPoolMiningCoinRef({
        id: coin.id,
        symbol: coin.symbol,
        nft_room_only: coin.nft_room_only,
        nftRoomOnly: coin.nftRoomOnly
      });

    const effectiveHashrate = effectiveNetworkHashrateForCoin(
      coinId,
      networkHashrate,
      realNetworkHashratesMap,
      undefined,
      { independentPool }
    );

    let yieldPerHash = 0;
    if (independentPool) {
      if (!(blockTime > 0)) {
        console.warn(`${LOG_PREFIX} block_time inválido coin=%s`, sanitizeForLog(coinId));
        yieldPerHash = 0;
      } else {
        const rewardPerSec = blockReward / blockTime;
        yieldPerHash = rewardPerSec / effectiveHashrate;
      }
    } else if (realNetHash > 0) {
      if (!(blockTime > 0)) {
        console.warn(`${LOG_PREFIX} block_time inválido coin=%s`, sanitizeForLog(coinId));
        yieldPerHash = 0;
      } else {
        const rewardPerSec = blockReward / blockTime;
        yieldPerHash = rewardPerSec / effectiveHashrate;
      }
    }

    if (!Number.isFinite(yieldPerHash) || yieldPerHash < 0) {
      console.warn(`${LOG_PREFIX} yieldPerHash inválido coin=%s — forçado a 0`, sanitizeForLog(coinId));
      yieldPerHash = 0;
    }

    coinIds.push(coinId);
    yields.push(yieldPerHash);
    rewards.push(blockReward);
    netHashes.push(effectiveHashrate);
    effectives.push(effectiveAtMs);
  }

  return { coinIds, yields, rewards, netHashes, effectives };
}

/** SQL canónico: UNIQUE(coin_id, effective_at) — conflito = já persistido, não é falha. */
export const MINING_YIELD_HISTORY_INSERT_SQL = `
INSERT INTO mining_yield_history (coin_id, yield_per_hash, block_reward, network_hashrate, effective_at)
SELECT * FROM UNNEST($1::text[], $2::float8[], $3::float8[], $4::float8[], $5::int8[])
ON CONFLICT (coin_id, effective_at) DO NOTHING
`.trim();

function isPgUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    String((err as { code: unknown }).code) === '23505'
  );
}

/**
 * Persiste um boundary. Idempotente sob UNIQUE(coin_id, effective_at):
 * - insert novo → ok
 * - já existe (ON CONFLICT DO NOTHING / 23505) → trata como persistido (não lança)
 * - erro real de BD → propaga (checkpoint NÃO deve avançar)
 */
async function insertYieldHistoryBoundary(
  client: PoolClient,
  coins: CoinYieldRow[],
  realNetworkHashratesMap: Map<string, number>,
  effectiveAtMs: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return;
  const { coinIds, yields, rewards, netHashes, effectives } = buildYieldHistoryRowsForBoundary(
    coins,
    realNetworkHashratesMap,
    effectiveAtMs
  );
  if (coinIds.length === 0) return;
  if (signal.aborted) return;
  try {
    await client.query(MINING_YIELD_HISTORY_INSERT_SQL, [coinIds, yields, rewards, netHashes, effectives]);
  } catch (e) {
    if (isPgUniqueViolation(e)) {
      // Race residual / constraint sem ON CONFLICT: boundary já canónico no banco.
      return;
    }
    throw e;
  }
}

/**
 * Um único scan de racks + upgrades + slots + multipliers: actualiza yields em BD,
 * stats em memória, ranking + app_cache (evita segundo job no bootstrap).
 *
 * O scheduler Node foi removido —
 * o worker Rust owns o loop. `executeMiningYieldTick` permanece para testes.
 */
/**
 * Tick de yield. AbortSignal é cooperativo: verifica entre batches de racks e
 * antes de BEGIN. Queries PG individuais em curso não são canceladas (limitação
 * do client `pg` sem query cancel explícito) — o tick deixa de avançar e faz
 * rollback se já estiver em transação.
 */
export async function executeMiningYieldTick(ctx: JobContext): Promise<void> {
  if (ctx.signal.aborted) return;
  const tickStart = Date.now();

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    if (ctx.signal.aborted) return;
    await hydrateYieldHistoryBoundaryFromDb(client);
    if (ctx.signal.aborted) return;

    // Leituras independentes (sem transação ainda — BEGIN só mais abaixo, na escrita) —
    // rodam em paralelo em conexões próprias do pool em vez de sequenciais na `client`
    // única. Reduz o tempo de parede do tick sem mudar nenhum cálculo/resultado.
    const [activeRes, upsRes, nftRoomIds, asicRoomIds, activeCoinsRes] = await Promise.all([
      pool.query(`
      SELECT pr.selected_coin_id, pr.id, pr.user_id, pr.item_id, pr.battery_id, pr.room_id, u.username
      FROM placed_racks pr
      JOIN users u ON pr.user_id = u.id
      WHERE pr.is_on = 1
      AND pr.wiring_id IS NOT NULL
      AND pr.battery_id IS NOT NULL
      AND u.is_blocked = 0
      AND u.ranking_excluded = 0
    `),
      pool.query('SELECT id, type, category, base_production, multiplier, nft_mining_coin_id FROM upgrades'),
      resolveNftAutoArmario1OnlyRoomIds({ query: (text, params) => client!.query(text, params) }),
      resolveAsicRoomIds({ query: (text, params) => client!.query(text, params) }),
      // Inclui params de yield — evita segunda query a mining_coins mais abaixo.
      pool.query('SELECT id, symbol, nft_room_only, block_reward, block_time, network_hashrate FROM mining_coins WHERE is_active = 1')
    ]);
    const upsMap = new Map<string, UpgradeMiningRow>();
    upsRes.rows.forEach((u) => upsMap.set(String(u.id), u as UpgradeMiningRow));

    const activeCoinIds = new Set(activeCoinsRes.rows.map((r) => String(r.id)));

    // Slots só dos racks ATIVOS (rack_id = ANY(...)) em vez da tabela inteira — `slotsMap`/
    // `multiMap` só são consultados pelos racks de `activeRes` mais abaixo, então racks
    // desligados/de outros users nunca eram usados mesmo lendo a tabela toda antes.
    const activeRackIds = activeRes.rows.map((r) => String((r as { id: string }).id));
    const [slotRes, multiRes] = activeRackIds.length
      ? await Promise.all([
          pool.query('SELECT rack_id, machine_item_id FROM rack_slots WHERE rack_id = ANY($1)', [activeRackIds]),
          pool.query('SELECT rack_id, multiplier_item_id FROM rack_multiplier_slots WHERE rack_id = ANY($1)', [activeRackIds])
        ])
      : [{ rows: [] as { rack_id: string; machine_item_id: string }[] }, { rows: [] as { rack_id: string; multiplier_item_id: string }[] }];

    const slotsMap: Record<string, string[]> = {};
    slotRes.rows.forEach((s) => {
      const rid = String(s.rack_id);
      if (!slotsMap[rid]) slotsMap[rid] = [];
      slotsMap[rid]!.push(s.machine_item_id);
    });

    const multiMap: Record<string, string[]> = {};
    multiRes.rows.forEach((m) => {
      const rid = String(m.rack_id);
      if (!multiMap[rid]) multiMap[rid] = [];
      multiMap[rid]!.push(m.multiplier_item_id);
    });

    const realNetworkHashratesMap = new Map<string, number>();
    const activeUsersSet = new Set<number>();
    const activeUsersByCoinVar = new Map<string, Set<number>>();
    const userStats = new Map<number, UserStat>();

    const racks = activeRes.rows as RackRow[];

    for (let i = 0; i < racks.length; i += BATCH_SIZE) {
      if (ctx.signal.aborted) return;
      const batch = racks.slice(i, i + BATCH_SIZE);

      for (const rack of batch) {
        const roomId = rack.room_id != null ? String(rack.room_id) : null;
        const slotCredits = listSlotMiningCredits(
          roomId,
          slotsMap[rack.id] || [],
          multiMap[rack.id] || [],
          upsMap,
          rack.selected_coin_id ? String(rack.selected_coin_id) : '',
          nftRoomIds,
          rack.item_id != null ? String(rack.item_id) : null,
          asicRoomIds
        );
        if (slotCredits.length === 0) continue;

        for (const sc of slotCredits) {
          const cid = sc.coinId;
          if (!activeCoinIds.has(cid)) continue;
          const power = sc.effectiveBaseProd;
          if (!Number.isFinite(power) || power <= 0) continue;

          realNetworkHashratesMap.set(cid, (realNetworkHashratesMap.get(cid) || 0) + power);

          activeUsersSet.add(rack.user_id);
          if (!activeUsersByCoinVar.has(cid)) activeUsersByCoinVar.set(cid, new Set());
          activeUsersByCoinVar.get(cid)!.add(rack.user_id);

          if (!userStats.has(rack.user_id)) {
            userStats.set(rack.user_id, { user_id: rack.user_id, username: rack.username, coins: {}, generalPower: 0 });
          }
          const uStat = userStats.get(rack.user_id)!;
          uStat.coins[cid] = (uStat.coins[cid] || 0) + power;
          if (creditCountsTowardGeneralPower(sc)) {
            uStat.generalPower += power;
          }
        }
      }

      if (i + BATCH_SIZE < racks.length) {
        await new Promise<void>((resolve) => setImmediate(() => resolve()));
      }
    }

    miningRuntimeStats.globalNetworkHashrates.clear();
    miningRuntimeStats.globalActiveMinersByCoin.clear();
    for (const [cid, total] of realNetworkHashratesMap.entries()) {
      miningRuntimeStats.globalNetworkHashrates.set(cid, total);
    }
    miningRuntimeStats.globalActiveMiners = activeUsersSet.size;
    for (const [cid, userSet] of activeUsersByCoinVar.entries()) {
      miningRuntimeStats.globalActiveMinersByCoin.set(cid, userSet.size);
    }

    const coinTotals: Record<string, number> = {};
    for (const [cid, v] of realNetworkHashratesMap.entries()) {
      coinTotals[cid] = v;
    }

    const activeMinersByCoin: Record<string, number> = {};
    let totalActiveUsers = 0;
    const rankingList: GlobalNetworkStatsState['ranking'] = [];

    userStats.forEach((u) => {
      const userCoins = Object.keys(u.coins);
      if (userCoins.length > 0) {
        totalActiveUsers++;
        rankingList.push({ ...u, totalPower: u.generalPower });
        userCoins.forEach((coinId) => {
          if (u.coins[coinId]! > 0) {
            activeMinersByCoin[coinId] = (activeMinersByCoin[coinId] || 0) + 1;
          }
        });
      }
    });

    rankingList.sort((a, b) => b.totalPower - a.totalPower);

    const newState: GlobalNetworkStatsState = { hashrates: coinTotals, activeMiners: totalActiveUsers, activeMinersByCoin, ranking: rankingList };
    setGlobalNetworkStats(newState);

    try {
      await client.query(
        `
        INSERT INTO app_cache (key, value, updated_at)
        VALUES ('network_stats', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
      `,
        [newState]
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`${LOG_PREFIX} app_cache network_stats:`, sanitizeForLog(msg, LOG_MSG_MAX_LEN));
    }

    const wallAt = Date.now();
    if (ctx.signal.aborted) return;
    const coinsRes = activeCoinsRes;
    const coinRows = coinsRes.rows as CoinYieldRow[];

    /**
     * Persistência de yield:
     * - Grelha ON: todos os boundaries pendentes em ordem (catch-up canónico).
     * - Grelha OFF: um snapshot em `wallAt` (comportamento legado contínuo).
     *
     * Política económica no catch-up: o mesmo snapshot de hashrate real / params
     * de `mining_coins` deste tick é reutilizado em cada boundary pendente.
     * Não existe série histórica de hashrate por boundary — não inventamos.
     */
    if (miningTenMinuteGridEnabled()) {
      const cap = lastCompletedTenMinuteUtcGrid(wallAt);
      const pendingAll = listPendingTenMinuteBoundaries(lastYieldHistoryBoundaryMs, cap);
      const pending = pendingAll.slice(0, MAX_YIELD_CATCHUP_BOUNDARIES_PER_TICK);

      if (pending.length > 1) {
        log.info('mining yield catch-up', {
          module: 'mining_yield',
          event: 'catch_up',
          pending: pending.length,
          deferred: Math.max(0, pendingAll.length - pending.length),
          from: pending[0],
          to: pending[pending.length - 1],
          checkpointBefore: lastYieldHistoryBoundaryMs,
          cap
        });
      }

      for (const boundary of pending) {
        if (ctx.signal.aborted) return;
        await client.query('BEGIN');
        try {
          await insertYieldHistoryBoundary(client, coinRows, realNetworkHashratesMap, boundary, ctx.signal);
          if (ctx.signal.aborted) {
            await client.query('ROLLBACK');
            return;
          }
          await client.query('COMMIT');
          // Avança mesmo se ON CONFLICT DO NOTHING (boundary já existia) —
          // conflito UNIQUE ≠ falha; só erros reais impedem o avanço (catch abaixo).
          lastYieldHistoryBoundaryMs = boundary;
        } catch (e) {
          safeRollback(client);
          const msg = e instanceof Error ? e.message : String(e);
          log.warn('mining yield boundary failed', {
            module: 'mining_yield',
            event: 'boundary_failed',
            boundary,
            err: sanitizeForLog(msg, LOG_MSG_MAX_LEN)
          });
          throw e;
        }
      }
    } else {
      await client.query('BEGIN');
      try {
        await insertYieldHistoryBoundary(client, coinRows, realNetworkHashratesMap, wallAt, ctx.signal);
        if (ctx.signal.aborted) {
          await client.query('ROLLBACK');
          return;
        }
        await client.query('COMMIT');
      } catch (e) {
        safeRollback(client);
        throw e;
      }
    }

    const retention = Date.now() - HISTORY_RETENTION_MS;
    if (ctx.signal.aborted) return;
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM mining_yield_history WHERE effective_at < $1', [retention]);
      if (ctx.signal.aborted) {
        await client.query('ROLLBACK');
        return;
      }
      await client.query('COMMIT');
    } catch (e) {
      safeRollback(client);
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`${LOG_PREFIX} retention delete:`, sanitizeForLog(msg, LOG_MSG_MAX_LEN));
    }

    const duration = Date.now() - tickStart;
    if (duration > SLOW_TICK_LOG_THRESHOLD_MS) {
      log.warn('mining yield tick slow', {
        module: 'mining_yield',
        event: 'slow_tick',
        durationMs: duration,
        rackCount: racks.length,
        activeUsers: totalActiveUsers
      });
    }

    const payload = {
      durationMs: duration,
      rackCount: racks.length,
      activeUsers: totalActiveUsers,
      at: wallAt,
      yieldHistoryBoundary: miningTenMinuteGridEnabled() ? lastYieldHistoryBoundaryMs : null
    };
    getSocketIo()?.emit('mining:tick', payload);
  } catch (e) {
    if (client) safeRollback(client);
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${LOG_PREFIX} erro:`, sanitizeForLog(msg, LOG_MSG_MAX_LEN));
    throw e;
  } finally {
    if (client) client.release();
  }
}

