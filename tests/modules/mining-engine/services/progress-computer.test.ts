import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MS_PER_SECOND } from '../../../../server/shared/utils/time.js';
import { TEN_MIN_MS } from '../../../../server/modules/mining-engine/services/wall-clock-grid.js';

const MOCK_NOW = 1_700_000_000_000;
const WORKER_URL_UNSET_ERROR = 'GENESIS_MINING_WORKER_URL unset';

describe('mining-engine services/progress-computer', () => {
  const poolMock = { connect: vi.fn() };
  let workerMock: { callMiningWorkerProgress: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('MINING_PROGRESS_COMPUTE_ENABLED', '1');
    workerMock = {
      callMiningWorkerProgress: vi.fn(async () => ({ ok: true, offlineMined: {} }))
    };
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => workerMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('../../../../server/modules/mining-engine/services/mining-worker-client.js');
  });

  async function loadModule() {
    return import('../../../../server/modules/mining-engine/services/progress-computer.js');
  }

  describe('calculateIntegratedYield', () => {
    it('devolve 0 se end <= start ou sem histórico', async () => {
      const { calculateIntegratedYield } = await loadModule();
      expect(calculateIntegratedYield('btc', 1000, 1000, [])).toBe(0);
      expect(calculateIntegratedYield('btc', 2000, 1000, [])).toBe(0);
      expect(calculateIntegratedYield('btc', 1000, 2000, undefined)).toBe(0);
    });

    it('integra taxa constante ao longo da janela', async () => {
      const { calculateIntegratedYield } = await loadModule();
      const hist = [{ coin_id: 'btc', yield_per_hash: 2, effective_at: 500 }];
      const out = calculateIntegratedYield('btc', 1000, 11_000, hist);
      expect(out).toBeCloseTo(20, 6);
    });

    it('integra por partes quando a taxa muda dentro da janela', async () => {
      const { calculateIntegratedYield } = await loadModule();
      const hist = [
        { coin_id: 'btc', yield_per_hash: 1, effective_at: 0 },
        { coin_id: 'btc', yield_per_hash: 3, effective_at: 5000 }
      ];
      const out = calculateIntegratedYield('btc', 0, 10_000, hist);
      expect(out).toBeCloseTo(20, 6);
    });
  });

  describe('computeProgressForUser', () => {
    it('updateTimestamp=false: early return sem HTTP', async () => {
      const { computeProgressForUser } = await loadModule();
      const out = await computeProgressForUser(poolMock as never, 1, MOCK_NOW, false);
      expect(out).toEqual({ ok: true });
      expect(workerMock.callMiningWorkerProgress).not.toHaveBeenCalled();
    });

    it('user id inválido devolve erro sem HTTP', async () => {
      const { computeProgressForUser } = await loadModule();
      const out = await computeProgressForUser(poolMock as never, 'abc', MOCK_NOW);
      expect(out).toEqual({ ok: false, error: 'invalid user' });
      expect(workerMock.callMiningWorkerProgress).not.toHaveBeenCalled();
    });

    it('desligado por env MINING_PROGRESS_COMPUTE_ENABLED=0 devolve ok sem HTTP', async () => {
      vi.stubEnv('MINING_PROGRESS_COMPUTE_ENABLED', '0');
      const { computeProgressForUser } = await loadModule();
      const out = await computeProgressForUser(poolMock as never, 1, MOCK_NOW);
      expect(out).toEqual({ ok: true });
      expect(workerMock.callMiningWorkerProgress).not.toHaveBeenCalled();
    });

    it('delega ao worker e devolve o payload', async () => {
      workerMock.callMiningWorkerProgress.mockResolvedValue({ ok: true, offlineMined: { btc: 1.5 } });
      const { computeProgressForUser } = await loadModule();
      const out = await computeProgressForUser(poolMock as never, 1, MOCK_NOW);
      expect(out).toEqual({ ok: true, offlineMined: { btc: 1.5 } });
      expect(workerMock.callMiningWorkerProgress).toHaveBeenCalledWith(1);
    });

    it('skipIfRecentMs: segundo tick imediato não chama o worker', async () => {
      workerMock.callMiningWorkerProgress.mockResolvedValue({ ok: true, offlineMined: {} });
      const { computeProgressForUser } = await loadModule();
      await computeProgressForUser(poolMock as never, 1, MOCK_NOW);
      expect(workerMock.callMiningWorkerProgress).toHaveBeenCalledTimes(1);
      const out = await computeProgressForUser(poolMock as never, 1, MOCK_NOW, true, { skipIfRecentMs: MS_PER_SECOND });
      expect(out).toEqual({ ok: true, offlineMined: {}, skippedRecent: true });
      expect(workerMock.callMiningWorkerProgress).toHaveBeenCalledTimes(1);
    });

    it('URL unset → GENESIS_MINING_WORKER_URL unset', async () => {
      workerMock.callMiningWorkerProgress.mockResolvedValue({ ok: false, error: WORKER_URL_UNSET_ERROR });
      const { computeProgressForUser } = await loadModule();
      const out = await computeProgressForUser(poolMock as never, 1, MOCK_NOW);
      expect(out).toEqual({ ok: false, error: WORKER_URL_UNSET_ERROR });
    });
  });

  describe('histórico canónico 10 min + invariantes', () => {
    const day0 = Date.UTC(2026, 7, 20, 0, 0, 0, 0);
    const TEN = TEN_MIN_MS;
    const t2220 = day0 + 22 * 60 * 60 * 1000 + 20 * 60 * 1000;
    const t2230 = t2220 + TEN;
    const t2240 = t2230 + TEN;
    const t2250 = t2240 + TEN;

    it('propriedade Y(a,c) ≈ Y(a,b)+Y(b,c) — constante, boundary e multi-taxa', async () => {
      const { calculateIntegratedYield } = await loadModule();
      const a = t2220;
      const b = t2230;
      const c = t2250;
      const constHist = [{ coin_id: 'pol', yield_per_hash: 0.002, effective_at: a - TEN }];
      expect(calculateIntegratedYield('pol', a, c, constHist)).toBeCloseTo(
        calculateIntegratedYield('pol', a, b, constHist) + calculateIntegratedYield('pol', b, c, constHist),
        10
      );

      const boundaryHist = [
        { coin_id: 'pol', yield_per_hash: 0.001, effective_at: a - TEN },
        { coin_id: 'pol', yield_per_hash: 0.003, effective_at: b }
      ];
      expect(calculateIntegratedYield('pol', a, c, boundaryHist)).toBeCloseTo(
        calculateIntegratedYield('pol', a, b, boundaryHist) + calculateIntegratedYield('pol', b, c, boundaryHist),
        10
      );

      const multi = [
        { coin_id: 'pol', yield_per_hash: 0.001, effective_at: a - TEN },
        { coin_id: 'pol', yield_per_hash: 0.002, effective_at: t2230 },
        { coin_id: 'pol', yield_per_hash: 0.004, effective_at: t2240 },
        { coin_id: 'pol', yield_per_hash: 0.005, effective_at: t2250 }
      ];
      const full = calculateIntegratedYield('pol', a, c + TEN, multi);
      const parts =
        calculateIntegratedYield('pol', a, t2230, multi) +
        calculateIntegratedYield('pol', t2230, t2240, multi) +
        calculateIntegratedYield('pol', t2240, t2250, multi) +
        calculateIntegratedYield('pol', t2250, c + TEN, multi);
      expect(full).toBeCloseTo(parts, 10);
    });

    it('TESTE 1 — 22:20→22:30: 1 janela, credit_blocks=1', async () => {
      const { buildMiningBlockHistoryRowsForCredit } = await loadModule();
      const rows = buildMiningBlockHistoryRowsForCredit({
        coinId: 'pol',
        roomId: 'room_a',
        intervalStartMs: t2220,
        intervalEndMs: t2230,
        sortedCoinHistory: [{ coin_id: 'pol', yield_per_hash: 0.001, effective_at: t2220 - TEN }],
        useHistoryIntegration: true,
        fallbackYieldPerHash: 0,
        effectiveHash: 100,
        usdRate: 1,
        networkHashrate: 1000,
        blockReward: 1,
        blockTime: 600
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ windowStartMs: t2220, windowEndMs: t2230, creditBlocks: 1 });
    });

    it('TESTE 2 — 22:20→22:50: 3 janelas, sem agregada 22:20→22:50', async () => {
      const { buildMiningBlockHistoryRowsForCredit } = await loadModule();
      const rows = buildMiningBlockHistoryRowsForCredit({
        coinId: 'pol',
        roomId: 'room_a',
        intervalStartMs: t2220,
        intervalEndMs: t2250,
        sortedCoinHistory: [{ coin_id: 'pol', yield_per_hash: 0.001, effective_at: t2220 - TEN }],
        useHistoryIntegration: true,
        fallbackYieldPerHash: 0,
        effectiveHash: 50,
        usdRate: 1,
        networkHashrate: 1000,
        blockReward: 1,
        blockTime: 600
      });
      expect(rows.map((r) => [r.windowStartMs, r.windowEndMs])).toEqual([
        [t2220, t2230],
        [t2230, t2240],
        [t2240, t2250]
      ]);
      expect(rows.every((r) => r.creditBlocks === 1)).toBe(true);
      expect(rows.some((r) => r.windowStartMs === t2220 && r.windowEndMs === t2250)).toBe(false);
    });

    it('TESTE 3+5 — invariante económico com 3 taxas; soma janelas ≈ full', async () => {
      const { buildMiningBlockHistoryRowsForCredit, calculateIntegratedYield } = await loadModule();
      const hist = [
        { coin_id: 'pol', yield_per_hash: 0.001, effective_at: t2220 - TEN },
        { coin_id: 'pol', yield_per_hash: 0.002, effective_at: t2230 },
        { coin_id: 'pol', yield_per_hash: 0.004, effective_at: t2240 }
      ];
      const hash = 80;
      const fullYield = calculateIntegratedYield('pol', t2220, t2250, hist);
      const fullAmount = hash * fullYield;
      const rows = buildMiningBlockHistoryRowsForCredit({
        coinId: 'pol',
        roomId: null,
        intervalStartMs: t2220,
        intervalEndMs: t2250,
        sortedCoinHistory: hist,
        useHistoryIntegration: true,
        fallbackYieldPerHash: 0,
        effectiveHash: hash,
        usdRate: 2,
        networkHashrate: 1000,
        blockReward: 1,
        blockTime: 600
      });
      expect(rows).toHaveLength(3);
      expect(rows[0]!.amountCoins).toBeCloseTo(hash * calculateIntegratedYield('pol', t2220, t2230, hist), 10);
      expect(rows[1]!.amountCoins).toBeCloseTo(hash * calculateIntegratedYield('pol', t2230, t2240, hist), 10);
      expect(rows[2]!.amountCoins).toBeCloseTo(hash * calculateIntegratedYield('pol', t2240, t2250, hist), 10);
      const sum = rows.reduce((acc, r) => acc + r.amountCoins, 0);
      expect(sum).toBeCloseTo(fullAmount, 10);
    });

    it('TESTE 4 — 3 créditos × 3 janelas → 9 rows', async () => {
      const { buildMiningBlockHistoryRowsForCredit } = await loadModule();
      const credits = [
        { coinId: 'a', roomId: 'r1', hash: 10 },
        { coinId: 'b', roomId: 'r2', hash: 20 },
        { coinId: 'c', roomId: 'r3', hash: 30 }
      ];
      const all = credits.flatMap((c) =>
        buildMiningBlockHistoryRowsForCredit({
          coinId: c.coinId,
          roomId: c.roomId,
          intervalStartMs: t2220,
          intervalEndMs: t2250,
          sortedCoinHistory: [{ coin_id: c.coinId, yield_per_hash: 0.001, effective_at: t2220 - TEN }],
          useHistoryIntegration: true,
          fallbackYieldPerHash: 0,
          effectiveHash: c.hash,
          usdRate: 1,
          networkHashrate: 1,
          blockReward: 1,
          blockTime: 600
        })
      );
      expect(all).toHaveLength(9);
    });

    it('P3 — 8 créditos mesma moeda × 1 janela → 1 row consolidada (SUM)', async () => {
      const { buildMiningBlockHistoryRowsForCredit, consolidateMiningBlockHistoryRows } = await loadModule();
      const hashes = [6, 1, 7, 2, 2, 2, 3, 2];
      const raw = hashes.flatMap((h, i) =>
        buildMiningBlockHistoryRowsForCredit({
          coinId: 'pol',
          roomId: i % 2 === 0 ? 'room_a' : 'room_b',
          intervalStartMs: t2220,
          intervalEndMs: t2230,
          sortedCoinHistory: [{ coin_id: 'pol', yield_per_hash: 0.001, effective_at: t2220 - TEN }],
          useHistoryIntegration: true,
          fallbackYieldPerHash: 0,
          effectiveHash: h,
          usdRate: 2,
          networkHashrate: 1000,
          blockReward: 0.55,
          blockTime: 600
        })
      );
      expect(raw).toHaveLength(8);
      const sumCoins = raw.reduce((a, r) => a + r.amountCoins, 0);
      const sumHps = raw.reduce((a, r) => a + r.userHashHps, 0);
      const cons = consolidateMiningBlockHistoryRows(raw);
      expect(cons).toHaveLength(1);
      expect(cons[0]!.coinId).toBe('pol');
      expect(cons[0]!.windowStartMs).toBe(t2220);
      expect(cons[0]!.windowEndMs).toBe(t2230);
      expect(cons[0]!.creditBlocks).toBe(1);
      expect(cons[0]!.amountCoins).toBeCloseTo(sumCoins, 10);
      expect(cons[0]!.userHashHps).toBeCloseTo(sumHps, 10);
      expect(cons[0]!.roomId).toBeNull();
    });

    it('P3 — catch-up 30min × 216 ASICs → 3 rows (não 648)', async () => {
      const { buildMiningBlockHistoryRowsForCredit, consolidateMiningBlockHistoryRows } = await loadModule();
      const raw = [];
      for (let i = 0; i < 216; i++) {
        raw.push(
          ...buildMiningBlockHistoryRowsForCredit({
            coinId: 'nft_pol',
            roomId: 'nft_room',
            intervalStartMs: t2220,
            intervalEndMs: t2250,
            sortedCoinHistory: [{ coin_id: 'nft_pol', yield_per_hash: 0.001, effective_at: t2220 - TEN }],
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
      expect(raw).toHaveLength(216 * 3);
      const cons = consolidateMiningBlockHistoryRows(raw);
      expect(cons).toHaveLength(3);
      expect(cons.every((r) => r.creditBlocks === 1)).toBe(true);
      expect(cons.every((r) => r.userHashHps === 216 * 5)).toBe(true);
      expect(cons.every((r) => r.roomId === 'nft_room')).toBe(true);
    });

    it('TESTE 10 — row antiga agregada + rows novas coexistentes (campos snapshot)', async () => {
      const mixed = [
        { id: '1', windowStartMs: t2220, windowEndMs: t2250, creditedBlocks: 3, amountCoins: 0.9 },
        { id: '2', windowStartMs: t2250, windowEndMs: t2250 + TEN, creditedBlocks: 1, amountCoins: 0.3 },
        { id: '3', windowStartMs: t2250 + TEN, windowEndMs: t2250 + 2 * TEN, creditedBlocks: 1, amountCoins: 0.3 }
      ];
      const sorted = [...mixed].sort((a, b) => b.windowEndMs - a.windowEndMs);
      expect(sorted[0]!.creditedBlocks).toBe(1);
      expect(sorted[sorted.length - 1]!.windowStartMs).toBe(t2220);
      expect(sorted[sorted.length - 1]!.windowEndMs).toBe(t2250);
    });
  });
});
