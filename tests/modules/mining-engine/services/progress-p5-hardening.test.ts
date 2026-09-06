/**
 * Plano 5 — blindagem: epsilon, snapshot contract, economia↔history, mismatch, partições.
 * Sem PG (unitário / pure).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  amountsAlmostEqual,
  assertAmountsAlmostEqual,
  MINING_AMOUNT_ABS_EPSILON,
  MINING_AMOUNT_REL_EPSILON
} from '../../../../server/modules/mining-engine/services/mining-economic-epsilon.js';
import { TEN_MIN_MS } from '../../../../server/modules/mining-engine/services/wall-clock-grid.js';

const TEN = TEN_MIN_MS;
const t0 = Date.UTC(2026, 7, 21, 10, 0, 0);

describe('mining-economic-epsilon (P5)', () => {
  it('epsilon único documentado', () => {
    expect(MINING_AMOUNT_ABS_EPSILON).toBe(1e-9);
    expect(MINING_AMOUNT_REL_EPSILON).toBe(1e-12);
  });

  it('amountsAlmostEqual aceita ruído float típico', () => {
    expect(amountsAlmostEqual(29.4, 29.400000000000006)).toBe(true);
    expect(amountsAlmostEqual(1, 1 + 1e-15)).toBe(true);
    expect(amountsAlmostEqual(1, 1.001)).toBe(false);
  });

  it('assertAmountsAlmostEqual lança fora do epsilon', () => {
    expect(() => assertAmountsAlmostEqual(1, 2, 'x')).toThrow(/MiningEpsilon/);
  });
});

describe('P5 — conservação de partições + snapshot contract', () => {
  async function load() {
    return import('../../../../server/modules/mining-engine/services/progress-computer.js');
  }

  it('estado fixo: catch-up T0→T60 ≡ 6×10min (economia + history por janela)', async () => {
    const {
      calculateIntegratedYield,
      buildMiningBlockHistoryRowsForCredit,
      consolidateMiningBlockHistoryRows,
      assertTickHistoryMatchesEconomy
    } = await load();
    const hist = [
      { coin_id: 'c', yield_per_hash: 0.001, effective_at: t0 - TEN },
      { coin_id: 'c', yield_per_hash: 0.002, effective_at: t0 + 2 * TEN },
      { coin_id: 'c', yield_per_hash: 0.0005, effective_at: t0 + 4 * TEN }
    ];
    const H = 7;
    const t60 = t0 + 6 * TEN;
    const catchUp = consolidateMiningBlockHistoryRows(
      buildMiningBlockHistoryRowsForCredit({
        coinId: 'c',
        roomId: 'r',
        intervalStartMs: t0,
        intervalEndMs: t60,
        sortedCoinHistory: hist,
        useHistoryIntegration: true,
        fallbackYieldPerHash: 0,
        effectiveHash: H,
        usdRate: 1,
        networkHashrate: 1,
        blockReward: 1,
        blockTime: 600
      })
    );
    const sequential = [];
    for (let i = 0; i < 6; i++) {
      sequential.push(
        ...buildMiningBlockHistoryRowsForCredit({
          coinId: 'c',
          roomId: 'r',
          intervalStartMs: t0 + i * TEN,
          intervalEndMs: t0 + (i + 1) * TEN,
          sortedCoinHistory: hist,
          useHistoryIntegration: true,
          fallbackYieldPerHash: 0,
          effectiveHash: H,
          usdRate: 1,
          networkHashrate: 1,
          blockReward: 1,
          blockTime: 600
        })
      );
    }
    const seqCons = consolidateMiningBlockHistoryRows(sequential);
    expect(catchUp).toHaveLength(6);
    expect(seqCons).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(amountsAlmostEqual(catchUp[i]!.amountCoins, seqCons[i]!.amountCoins)).toBe(true);
    }
    const econ = H * calculateIntegratedYield('c', t0, t60, hist);
    assertTickHistoryMatchesEconomy(new Map([['c', econ]]), catchUp);

    for (const parts of [1, 2, 3, 6]) {
      const step = 6 / parts;
      let sum = 0;
      for (let p = 0; p < parts; p++) {
        const s = t0 + p * step * TEN;
        const e = t0 + (p + 1) * step * TEN;
        sum += H * calculateIntegratedYield('c', s, e, hist);
      }
      expect(amountsAlmostEqual(sum, econ)).toBe(true);
    }
  });

  it('estado mutável: catch-up com H_final ≠ soma de H por janela (snapshot, não bug)', async () => {
    const { buildMiningBlockHistoryRowsForCredit, consolidateMiningBlockHistoryRows } = await load();
    const hist = [{ coin_id: 'c', yield_per_hash: 0.001, effective_at: t0 - TEN }];
    // Replay físico conceptual: H=2,6,1
    const physical = [
      ...buildMiningBlockHistoryRowsForCredit({
        coinId: 'c',
        roomId: null,
        intervalStartMs: t0,
        intervalEndMs: t0 + TEN,
        sortedCoinHistory: hist,
        useHistoryIntegration: true,
        fallbackYieldPerHash: 0,
        effectiveHash: 2,
        usdRate: 1,
        networkHashrate: 1,
        blockReward: 1,
        blockTime: 600
      }),
      ...buildMiningBlockHistoryRowsForCredit({
        coinId: 'c',
        roomId: null,
        intervalStartMs: t0 + TEN,
        intervalEndMs: t0 + 2 * TEN,
        sortedCoinHistory: hist,
        useHistoryIntegration: true,
        fallbackYieldPerHash: 0,
        effectiveHash: 6,
        usdRate: 1,
        networkHashrate: 1,
        blockReward: 1,
        blockTime: 600
      }),
      ...buildMiningBlockHistoryRowsForCredit({
        coinId: 'c',
        roomId: null,
        intervalStartMs: t0 + 2 * TEN,
        intervalEndMs: t0 + 3 * TEN,
        sortedCoinHistory: hist,
        useHistoryIntegration: true,
        fallbackYieldPerHash: 0,
        effectiveHash: 1,
        usdRate: 1,
        networkHashrate: 1,
        blockReward: 1,
        blockTime: 600
      })
    ];
    // Snapshot catch-up às 10:30 com H=1
    const snap = consolidateMiningBlockHistoryRows(
      buildMiningBlockHistoryRowsForCredit({
        coinId: 'c',
        roomId: null,
        intervalStartMs: t0,
        intervalEndMs: t0 + 3 * TEN,
        sortedCoinHistory: hist,
        useHistoryIntegration: true,
        fallbackYieldPerHash: 0,
        effectiveHash: 1,
        usdRate: 1,
        networkHashrate: 1,
        blockReward: 1,
        blockTime: 600
      })
    );
    const physSum = physical.reduce((a, r) => a + r.amountCoins, 0);
    const snapSum = snap.reduce((a, r) => a + r.amountCoins, 0);
    expect(amountsAlmostEqual(physSum, snapSum)).toBe(false);
    expect(snapSum).toBeLessThan(physSum);
  });

  it('8 racks / 216 ASICs → 1 row canónica; economia = Σ', async () => {
    const { buildMiningBlockHistoryRowsForCredit, consolidateMiningBlockHistoryRows, assertTickHistoryMatchesEconomy } =
      await load();
    const hist = [{ coin_id: 'pol', yield_per_hash: 0.001, effective_at: t0 - TEN }];
    const racks = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((h) =>
      buildMiningBlockHistoryRowsForCredit({
        coinId: 'pol',
        roomId: 'room_a',
        intervalStartMs: t0,
        intervalEndMs: t0 + TEN,
        sortedCoinHistory: hist,
        useHistoryIntegration: true,
        fallbackYieldPerHash: 0,
        effectiveHash: h,
        usdRate: 1,
        networkHashrate: 1,
        blockReward: 1,
        blockTime: 600
      })
    );
    const consRacks = consolidateMiningBlockHistoryRows(racks);
    expect(consRacks).toHaveLength(1);
    assertTickHistoryMatchesEconomy(new Map([['pol', racks.reduce((a, r) => a + r.amountCoins, 0)]]), consRacks);

    const asics = [];
    for (let i = 0; i < 216; i++) {
      asics.push(
        ...buildMiningBlockHistoryRowsForCredit({
          coinId: 'nft',
          roomId: 'nft',
          intervalStartMs: t0,
          intervalEndMs: t0 + TEN,
          sortedCoinHistory: [{ coin_id: 'nft', yield_per_hash: 0.001, effective_at: t0 - TEN }],
          useHistoryIntegration: true,
          fallbackYieldPerHash: 0,
          effectiveHash: 5,
          usdRate: 1,
          networkHashrate: 1,
          blockReward: 1,
          blockTime: 600
        })
      );
    }
    const consNft = consolidateMiningBlockHistoryRows(asics);
    expect(consNft).toHaveLength(1);
    expect(consNft[0]!.userHashHps).toBe(216 * 5);
    assertTickHistoryMatchesEconomy(new Map([['nft', asics.reduce((a, r) => a + r.amountCoins, 0)]]), consNft);
  });
});

describe('P5 — assertCanonicalHistoryCompatible', () => {
  it('mismatch fora do epsilon → MiningBlockHistoryMismatchError', async () => {
    const { assertCanonicalHistoryCompatible, MiningBlockHistoryMismatchError } = await import(
      '../../../../server/modules/mining-engine/services/progress-computer.js'
    );
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{ coin_id: 'pol', window_start_ms: t0, window_end_ms: t0 + TEN, amount_coins: 1.0 }]
      })
    };
    await expect(
      assertCanonicalHistoryCompatible(client, 1, [
        {
          coinId: 'pol',
          roomId: null,
          windowStartMs: t0,
          windowEndMs: t0 + TEN,
          creditBlocks: 1,
          amountCoins: 2.0,
          amountUsd: 0,
          userHashHps: 1,
          networkHashrate: 1,
          blockReward: 1,
          blockTime: 600
        }
      ])
    ).rejects.toBeInstanceOf(MiningBlockHistoryMismatchError);
  });

  it('match dentro do epsilon → MiningBlockHistoryAlreadyCreditedError', async () => {
    const { assertCanonicalHistoryCompatible, MiningBlockHistoryAlreadyCreditedError } = await import(
      '../../../../server/modules/mining-engine/services/progress-computer.js'
    );
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{ coin_id: 'pol', window_start_ms: t0, window_end_ms: t0 + TEN, amount_coins: 1.0 }]
      })
    };
    await expect(
      assertCanonicalHistoryCompatible(client, 1, [
        {
          coinId: 'pol',
          roomId: null,
          windowStartMs: t0,
          windowEndMs: t0 + TEN,
          creditBlocks: 1,
          amountCoins: 1.0 + 1e-15,
          amountUsd: 0,
          userHashHps: 1,
          networkHashrate: 1,
          blockReward: 1,
          blockTime: 600
        }
      ])
    ).rejects.toBeInstanceOf(MiningBlockHistoryAlreadyCreditedError);
  });
});

describe('P5 — gaps documentation (no false bug)', () => {
  it('gap entre janelas sem overlap não implica duplicação', () => {
    const windows = [
      { start: t0, end: t0 + TEN },
      { start: t0 + 2 * TEN, end: t0 + 3 * TEN }
    ];
    expect(windows[1]!.start).toBeGreaterThan(windows[0]!.end);
    expect(windows[0]!.end).toBeLessThanOrEqual(windows[1]!.start);
  });
});
