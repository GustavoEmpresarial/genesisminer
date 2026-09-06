/**
 * Ranking público de mineração (poder H/s por moeda/utilizador) + variantes
 * admin (`coin_balances` por utilizador) e "minha posição" (cache dedicado,
 * baixo TTL, pro polling do header do jogo).
 *
 * Migrado de legacy/backend/lib/miningRankingPrisma.ts. `getAdminMiningRankingPayload`
 * e `computePublicMiningRankingPayloadUncached` partilhavam quase toda a
 * varredura (moedas/upgrades/salas NFT/utilizadores elegíveis/racks/slots) —
 * extraída pra `loadRankingScanData()` em vez de duplicar (o legado duplicava
 * as duas funções quase por inteiro).
 */
import { prisma } from '../../../core/database/prisma.js';
import { normalizePlacedRackRoomId } from '../../mining-engine/services/rack-room-id.js';
import {
  creditCountsTowardGeneralPower,
  isNftAutoArmario1OnlyRoomRow,
  listSlotMiningCredits,
  NFT_AUTO_ROOM_ID,
  type UpgradeMiningRow
} from '../../mining-engine/services/nft-room-mining.js';
import { ASIC_ROOM_ID, isAsicMiningRoomId } from '../../mining-engine/services/room-kind.js';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../../../shared/utils/time.js';
import { getRedis } from '../../../core/redis/client.js';
import { opsConfig } from '../../../core/ops/config.js';
import { log } from '../../../core/ops/logger.js';
import { callRankingAdmin, callRankingMe, callRankingPublic } from './ranking-worker-client.js';

export type CoinLite = { id: string; name: string; symbol: string };

export type PublicRankingUser = {
  user_id: number;
  username: string;
  /** Poder por moeda (inclui Sala NFT / ASIC). */
  coins: Record<string, number>;
  /** Poder por moeda só de créditos com `countsTowardGeneralPower` (fora Sala NFT / ASICs). */
  generalCoins: Record<string, number>;
};

/** Soma H/s para o ranking global (exclui créditos da Sala NFT). */
export function sumGeneralRankingPower(generalCoins: Record<string, number> | null | undefined): number {
  if (!generalCoins) return 0;
  let total = 0;
  for (const v of Object.values(generalCoins)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

async function loadNftMiningRoomIds(): Promise<Set<string>> {
  const rows = await prisma.rig_rooms.findMany({ select: { id: true, name: true } });
  const ids = new Set<string>();
  const canonical = normalizePlacedRackRoomId(NFT_AUTO_ROOM_ID);
  for (const r of rows) {
    const id = normalizePlacedRackRoomId(r.id);
    if (id === canonical || isNftAutoArmario1OnlyRoomRow(r)) ids.add(id);
  }
  ids.add(canonical);
  return ids;
}

/** Alinhado a `loadAsicMiningRoomIds` do calculator / `resolveAsicRoomIds`. */
async function loadAsicMiningRoomIds(): Promise<Set<string>> {
  const rows = await prisma.rig_rooms.findMany({ select: { id: true, name: true } });
  const ids = new Set<string>();
  for (const r of rows) {
    const id = normalizePlacedRackRoomId(r.id);
    if (isAsicMiningRoomId(id, null, r.name)) ids.add(id);
  }
  ids.add(normalizePlacedRackRoomId(ASIC_ROOM_ID));
  return ids;
}

function buildUpgradesMiningMap(
  upgrades: Array<{
    id: string;
    type: string;
    category: string;
    base_production: number;
    multiplier: number | null;
    nft_mining_coin_id: string | null;
  }>
): Map<string, UpgradeMiningRow> {
  const m = new Map<string, UpgradeMiningRow>();
  for (const u of upgrades) {
    m.set(u.id, {
      id: u.id,
      type: u.type,
      category: u.category,
      base_production: u.base_production,
      multiplier: u.multiplier,
      nft_mining_coin_id: u.nft_mining_coin_id
    });
  }
  return m;
}

function slotIdsFromRows(rows: Array<{ machine_item_id: string | null }>): string[] {
  const out: string[] = [];
  for (const s of rows) {
    if (s.machine_item_id) out.push(String(s.machine_item_id));
  }
  return out;
}

function multIdsFromRows(rows: Array<{ multiplier_item_id: string | null }>): string[] {
  const out: string[] = [];
  for (const m of rows) {
    if (m.multiplier_item_id) out.push(String(m.multiplier_item_id));
  }
  return out;
}

/** Poder por moeda (alinhado com `listSlotMiningCredits` / header do jogo). */
/** `T` cobre tanto `PublicRankingUser` quanto `AdminRankingUser` (que só acrescenta `balances`). */
async function accumulateRankingPowerFromRacks<T extends PublicRankingUser>(
  rankingData: Map<number, T>,
  racks: Array<{
    id: string;
    user_id: number;
    selected_coin_id: string | null;
    room_id: string | null;
    item_id?: string | null;
  }>,
  slotsByRack: Map<string, Array<{ machine_item_id: string | null }>>,
  multByRack: Map<string, Array<{ multiplier_item_id: string | null }>>,
  upgradesMining: Map<string, UpgradeMiningRow>,
  nftRoomIds: Set<string>,
  asicRoomIds: Set<string>,
  usernameById: Map<number, string>
): Promise<void> {
  for (const rack of racks) {
    const uname = usernameById.get(rack.user_id);
    if (uname == null) continue;

    const slots = slotIdsFromRows(slotsByRack.get(rack.id) || []);
    const multSlots = multIdsFromRows(multByRack.get(rack.id) || []);
    const selectedCoinId = rack.selected_coin_id ? String(rack.selected_coin_id).trim() : '';
    const credits = listSlotMiningCredits(
      rack.room_id != null ? String(rack.room_id) : null,
      slots,
      multSlots,
      upgradesMining,
      selectedCoinId,
      nftRoomIds,
      rack.item_id != null ? String(rack.item_id) : null,
      asicRoomIds
    );
    if (credits.length === 0) continue;

    if (!rankingData.has(rack.user_id)) {
      // Só acontece no ranking público (admin pré-semeia todos os elegíveis antes de chamar).
      rankingData.set(rack.user_id, { user_id: rack.user_id, username: uname, coins: {}, generalCoins: {} } as T);
    }
    const uData = rankingData.get(rack.user_id)!;
    for (const sc of credits) {
      if (!Number.isFinite(sc.effectiveBaseProd) || sc.effectiveBaseProd <= 0) continue;
      uData.coins[sc.coinId] = (uData.coins[sc.coinId] || 0) + sc.effectiveBaseProd;
      if (creditCountsTowardGeneralPower(sc)) {
        uData.generalCoins[sc.coinId] = (uData.generalCoins[sc.coinId] || 0) + sc.effectiveBaseProd;
      }
    }
  }
}

export type PublicMiningRankingPayload = {
  timestamp: number;
  ranking: PublicRankingUser[];
  coins: CoinLite[];
};

type RankingScanData = {
  coins: CoinLite[];
  upgradesMining: Map<string, UpgradeMiningRow>;
  nftRoomIds: Set<string>;
  asicRoomIds: Set<string>;
  eligibleUsers: Array<{ id: number; username: string }>;
  racks: Array<{ id: string; user_id: number; item_id: string; selected_coin_id: string | null; room_id: string | null }>;
  slotsByRack: Map<string, Array<{ machine_item_id: string | null }>>;
  multByRack: Map<string, Array<{ multiplier_item_id: string | null }>>;
};

/**
 * Varre TODOS os utilizadores elegíveis pro ranking + as racks ligadas deles —
 * é a query mais pesada do módulo, partilhada por `getPublicMiningRankingPayload`
 * (via snapshot no Redis, refeito pelo job de fundo) e `getAdminMiningRankingPayload`
 * (painel admin, chamado sob demanda). Nunca chamar direto fora deste arquivo.
 */
async function loadRankingScanData(): Promise<RankingScanData> {
  // Catálogo + elegíveis: independentes — paraleliza round-trips.
  const [coins, upgrades, nftRoomIds, asicRoomIds, eligibleUsers] = await Promise.all([
    prisma.mining_coins.findMany({
      select: { id: true, name: true, symbol: true }
    }),
    prisma.upgrades.findMany({
      select: {
        id: true,
        type: true,
        category: true,
        base_production: true,
        multiplier: true,
        nft_mining_coin_id: true
      }
    }),
    loadNftMiningRoomIds(),
    loadAsicMiningRoomIds(),
    prisma.users.findMany({
      where: { is_blocked: 0, ranking_excluded: 0 },
      select: { id: true, username: true }
    })
  ]);
  const upgradesMining = buildUpgradesMiningMap(upgrades);
  const eligibleIds = eligibleUsers.map((u) => u.id);

  const racks =
    eligibleIds.length === 0
      ? []
      : await prisma.placed_racks.findMany({
          where: {
            is_on: 1,
            user_id: { in: eligibleIds },
            wiring_id: { not: null },
            battery_id: { not: null }
          },
          select: {
            id: true,
            user_id: true,
            item_id: true,
            selected_coin_id: true,
            room_id: true
          }
        });

  const rackIds = racks.map((r) => r.id);
  const [allSlots, allMult] =
    rackIds.length === 0
      ? [[], []]
      : await Promise.all([
          prisma.rack_slots.findMany({
            where: { rack_id: { in: rackIds } },
            select: { rack_id: true, machine_item_id: true }
          }),
          prisma.rack_multiplier_slots.findMany({
            where: { rack_id: { in: rackIds } },
            select: { rack_id: true, multiplier_item_id: true }
          })
        ]);

  const slotsByRack = new Map<string, Array<{ machine_item_id: string | null }>>();
  for (const s of allSlots) {
    const k = s.rack_id;
    if (!slotsByRack.has(k)) slotsByRack.set(k, []);
    slotsByRack.get(k)!.push(s);
  }
  const multByRack = new Map<string, Array<{ multiplier_item_id: string | null }>>();
  for (const m of allMult) {
    const k = m.rack_id;
    if (!multByRack.has(k)) multByRack.set(k, []);
    multByRack.get(k)!.push(m);
  }

  return { coins, upgradesMining, nftRoomIds, asicRoomIds, eligibleUsers, racks, slotsByRack, multByRack };
}

async function computePublicMiningRankingPayloadUncached(): Promise<PublicMiningRankingPayload> {
  const { coins, upgradesMining, nftRoomIds, asicRoomIds, eligibleUsers, racks, slotsByRack, multByRack } =
    await loadRankingScanData();
  const usernameById = new Map(eligibleUsers.map((u) => [u.id, u.username]));

  const rankingData = new Map<number, PublicRankingUser>();
  await accumulateRankingPowerFromRacks(
    rankingData,
    racks,
    slotsByRack,
    multByRack,
    upgradesMining,
    nftRoomIds,
    asicRoomIds,
    usernameById
  );

  return {
    timestamp: Date.now(),
    ranking: Array.from(rankingData.values()),
    coins: coins.map((c) => ({ id: c.id, name: c.name, symbol: c.symbol }))
  };
}

export type AdminRankingUser = PublicRankingUser & {
  /** Saldo actual por moeda minerável (`coin_balances`) — só no ranking admin. */
  balances: Record<string, number>;
};

export type AdminMiningRankingPayload = {
  timestamp: number;
  ranking: AdminRankingUser[];
  coins: CoinLite[];
};

/**
 * Ranking admin: poder + saldos `coin_balances` por moeda minerável. Ao
 * contrário do ranking público, pré-semeia TODOS os utilizadores elegíveis
 * (mesmo com poder zero) e só filtra no final quem não tem poder nem saldo
 * — o painel admin quer ver quem está "zerado" também, até certo ponto.
 */
export async function getAdminMiningRankingPayload(): Promise<AdminMiningRankingPayload> {
  return (await callRankingAdmin()) as AdminMiningRankingPayload;
}

const RANKING_REDIS_KEY = 'ranking:public:v1';

const RANKING_REFRESH_INTERVAL_DEFAULT_MINUTES = 5;
/** Intervalo do job de fundo que recalcula o snapshot (env `RANKING_REFRESH_INTERVAL_MS`, default 5min). */
export const RANKING_REFRESH_INTERVAL_MS = (() => {
  const parsed = parseInt(String(process.env.RANKING_REFRESH_INTERVAL_MS || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : RANKING_REFRESH_INTERVAL_DEFAULT_MINUTES * MS_PER_MINUTE;
})();
/** TTL da chave no Redis: folga sobre o intervalo do job, pra sobreviver a um refresh atrasado sem sumir. */
const RANKING_REDIS_TTL_SECONDS_MULTIPLIER = 3;
const RANKING_REDIS_TTL_SECONDS = Math.ceil((RANKING_REFRESH_INTERVAL_MS * RANKING_REDIS_TTL_SECONDS_MULTIPLIER) / MS_PER_SECOND);

/** Dedup de concorrência: várias leituras simultâneas em cache-miss reaproveitam o mesmo cálculo em vez de repeti-lo. */
let inFlightCompute: Promise<PublicMiningRankingPayload> | null = null;

async function computeAndCacheRankingPayload(): Promise<PublicMiningRankingPayload> {
  if (inFlightCompute) return inFlightCompute;
  inFlightCompute = (async () => {
    const payload = await computePublicMiningRankingPayloadUncached();
    const redis = getRedis();
    if (redis) {
      try {
        await redis.set(RANKING_REDIS_KEY, JSON.stringify(payload), 'EX', RANKING_REDIS_TTL_SECONDS);
      } catch (e) {
        console.warn('[ranking] falha ao gravar snapshot no Redis:', e instanceof Error ? e.message : String(e));
      }
    }
    return payload;
  })();
  try {
    return await inFlightCompute;
  } finally {
    inFlightCompute = null;
  }
}

async function writeRankingSnapshot(payload: PublicMiningRankingPayload): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(RANKING_REDIS_KEY, JSON.stringify(payload), 'EX', RANKING_REDIS_TTL_SECONDS);
    } catch (e) {
      console.warn('[ranking] falha ao gravar snapshot no Redis:', e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * Recalcula o ranking e grava o snapshot no Redis — chamado pelo job de fundo
 * (`startPublicMiningRankingRefreshLoop`). Também pode ser chamado manualmente
 * (ex.: script de warm-up no boot).
 *
 * Limitação: o scan Prisma (`loadRankingScanData`) em curso não é cancelável
 * sem cancelar queries; com `signal`, impede início e gravação pós-scan se abortado.
 * O caminho com signal NÃO partilha `inFlightCompute` com requests HTTP.
 */
export async function refreshPublicMiningRankingSnapshot(signal?: AbortSignal): Promise<PublicMiningRankingPayload> {
  const t0 = Date.now();
  if (!signal) {
    const payload = await computeAndCacheRankingPayload();
    const durationMs = Date.now() - t0;
    if (durationMs >= opsConfig.slowHttpMs) {
      log.warn('public ranking refresh slow', {
        module: 'ranking',
        event: 'slow_refresh',
        durationMs,
        rankingSize: payload.ranking.length
      });
    }
    return payload;
  }
  if (signal.aborted) {
    throw Object.assign(new Error('ranking aborted'), { name: 'AbortError' });
  }
  const payload = await computePublicMiningRankingPayloadUncached();
  if (signal.aborted) {
    throw Object.assign(new Error('ranking aborted'), { name: 'AbortError' });
  }
  await writeRankingSnapshot(payload);
  const durationMs = Date.now() - t0;
  if (durationMs >= opsConfig.slowHttpMs) {
    log.warn('public ranking refresh slow', {
      module: 'ranking',
      event: 'slow_refresh',
      durationMs,
      rankingSize: payload.ranking.length
    });
  }
  return payload;
}

/**
 * Job de fundo Node: sempre no-op — o worker Rust owns o loop de ranking.
 */
export function startPublicMiningRankingRefreshLoop(_intervalMs: number = RANKING_REFRESH_INTERVAL_MS): () => void {
  log.info('public ranking refresh not scheduled', {
    module: 'ranking',
    event: 'disabled',
    reason: 'Rust worker owns ranking loop'
  });
  return () => undefined;
}

/** Só para testes (Vitest); invalida os caches locais (Redis mockado não precisa disso). */
export function resetPublicMiningRankingCacheForTests(): void {
  inFlightCompute = null;
}

/** Kafka `genesis.ranking.snapshot` — limpa fallbacks locais nas réplicas Node. */
export function invalidateRankingCachesFromKafka(): void {
  inFlightCompute = null;
}

/**
 * Ranking público: poder por moeda por utilizador (mesmas regras que o jogo).
 *
 * Lê o snapshot pronto do **Redis**, escrito pelo job de fundo
 * (`startPublicMiningRankingRefreshLoop`, a cada `RANKING_REFRESH_INTERVAL_MS`
 * — default 5min) — não escaneia utilizadores/racks a cada request, não
 * importa quantos utilizadores estejam online ao mesmo tempo.
 *
 * Sem Redis configurado, ou em cache-miss (job ainda não rodou / snapshot
 * expirou), calcula uma vez, guarda no Redis (se disponível) e num fallback
 * local de TTL curto — chamadas concorrentes nesse instante reaproveitam o
 * mesmo cálculo em vez de repeti-lo (`inFlightCompute`).
 *
 * `{ fresh: true }` ignora tudo isso e força um recálculo + regravação —
 * usar só quando precisar de dado 100% ao vivo.
 */
export async function getPublicMiningRankingPayload(opts?: { fresh?: boolean }): Promise<PublicMiningRankingPayload> {
  return (await callRankingPublic(!!opts?.fresh)) as PublicMiningRankingPayload;
}

export type MyGlobalMiningRank = { position: number | null; totalRanked: number; hash: number };

/** Posição 1-based do jogador no ranking global (H/s fora da Sala NFT). */
export async function getMyGlobalMiningRank(userId: number, opts?: { fresh?: boolean }): Promise<MyGlobalMiningRank> {
  const uid = Math.floor(Number(userId));
  if (!Number.isFinite(uid) || uid <= 0) {
    return { position: null, totalRanked: 0, hash: 0 };
  }
  return await callRankingMe(uid, !!opts?.fresh);
}

/** Só para testes (Vitest); cache local de "minha posição" já não existe (HTTP worker). */
export function resetMyGlobalMiningRankCacheForTests(): void {
  return;
}
