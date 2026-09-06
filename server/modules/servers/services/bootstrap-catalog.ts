/**
 * Subconjunto de `lib/publicBootstrapPayload.ts` usado por `GET /api/servers/state`
 * (`loadUpgradesForBootstrap`/`loadMiningCoinsForBootstrap`) — o resto do arquivo
 * original (access levels, loot boxes, economy/web3 settings, system news, etc.)
 * pertence ao bootstrap público completo do SPA, não migrado ainda.
 *
 * Migrado de legacy/backend/lib/publicBootstrapPayload.ts.
 */
import { prisma } from '../../../core/database/prisma.js';
import pool from '../../../core/database/pool.js';
import {
  hydrateMiningRuntimeStatsFromAppCache,
  miningRuntimeStats
} from '../../mining-engine/services/runtime-stats.js';
import { mapUpgradeRowToApi } from './upgrade-catalog-shape.js';

const DEFAULT_NETWORK_HASHRATE = 100;

export async function loadUpgradesForBootstrap(userId: number | undefined): Promise<unknown[]> {
  let isAdminUser = false;
  if (userId) {
    const uRow = await prisma.users.findUnique({ where: { id: userId }, select: { is_admin: true } });
    if (uRow?.is_admin) isAdminUser = true;
  }

  const rows = await prisma.upgrades.findMany({
    where: isAdminUser
      ? { AND: [{ NOT: { id: { startsWith: 'temp_legacy_' } } }, { category: { not: 'legacy-temp' } }, { type: { not: 'legacy-temp' } }] }
      : {
          AND: [
            { is_active: 1 },
            { status: { notIn: ['legacy', 'exclusive', 'retired'] } }
          ]
        }
  });
  const compatRows = await prisma.upgrade_compat_racks.findMany();

  const compatMap = compatRows.reduce<Record<string, string[]>>((acc, r) => {
    acc[r.upgrade_id] = acc[r.upgrade_id] || [];
    acc[r.upgrade_id].push(r.rack_id);
    return acc;
  }, {});

  return rows.map((r) => mapUpgradeRowToApi(r, compatMap[r.id] || []));
}

export async function loadMiningCoinsForBootstrap(): Promise<unknown[]> {
  await hydrateMiningRuntimeStatsFromAppCache(pool);
  const resDb = await pool.query('SELECT * FROM mining_coins ORDER BY name ASC');
  return resDb.rows.map((r: Record<string, unknown>) => {
    let usedRate = parseFloat(String(r.network_hashrate)) || DEFAULT_NETWORK_HASHRATE;
    if (miningRuntimeStats.globalNetworkHashrates.has(String(r.id))) {
      const dyn = miningRuntimeStats.globalNetworkHashrates.get(String(r.id));
      if (dyn && dyn > 0) usedRate = dyn;
    }
    return {
      id: r.id,
      name: r.name,
      symbol: r.symbol,
      description: r.description,
      color: r.color,
      algorithm: r.algorithm,
      multiplier: r.multiplier,
      difficulty: r.difficulty,
      minProportion: r.min_proportion,
      usdcRate: r.usdc_rate,
      isActive: !!r.is_active,
      networkHashrate: usedRate,
      blockReward: r.block_reward,
      blockTime: r.block_time,
      priceUSD: r.price_usd,
      targetDailyUSD: parseFloat(String(r.target_daily_usd)) || 0,
      showInExchange: !!r.show_in_exchange,
      nftRoomOnly: Number(r.nft_room_only ?? 0) === 1
    };
  });
}
