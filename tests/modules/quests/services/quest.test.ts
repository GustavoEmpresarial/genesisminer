import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DEF_DAILY_CHECKIN = { id: 'daily_checkin', period: 'daily', action_type: 'checkin', title: 'Check-in diário', description: '', target_count: 1, reward_usdc: 0.05, sort_order: 10, enabled: 1, updated_at: 0 };
const DEF_WEEKLY_CHECKIN = { id: 'weekly_checkin', period: 'weekly', action_type: 'checkin', title: 'Check-in da semana', description: '', target_count: 5, reward_usdc: 0.5, sort_order: 110, enabled: 1, updated_at: 0 };

describe('quests services/quest', () => {
  let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let dbMock: Record<string, any>;
  let premiumPolicyMock: Record<string, any>;
  let enabledDefs: any[];
  let callWalletQuestClaim: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    enabledDefs = [DEF_DAILY_CHECKIN, DEF_WEEKLY_CHECKIN];

    client = { query: vi.fn(), release: vi.fn() };
    dbMock = {
      default: {
        connect: vi.fn(async () => client),
        query: vi.fn(async (sql: string) => {
          const s = String(sql);
          if (s.includes('FROM quest_definitions') && s.includes('WHERE enabled = 1') && !s.includes('id = $1')) {
            return { rows: enabledDefs };
          }
          return { rows: [], rowCount: 0 };
        })
      }
    };
    premiumPolicyMock = {
      resolveUserCheckinPremiumContext: vi.fn().mockResolvedValue({ premiumWeeklyCheckin: false, policy: { intervalDays: 7 } }),
      isPremiumWithinActiveWindow: vi.fn().mockReturnValue(false)
    };
    callWalletQuestClaim = vi.fn().mockResolvedValue({ ok: true, rewardUsdc: 0.05, newUsdc: 5.05 });
    vi.doMock('../../../../server/core/database/pool.js', () => dbMock);
    vi.doMock('../../../../server/modules/checkin/services/premium-policy.js', () => premiumPolicyMock);
    vi.doMock('../../../../server/modules/wallet/services/wallet-worker-client.js', () => ({
      callWalletQuestClaim
    }));
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => ({
      callQuestsState: vi.fn().mockResolvedValue({
        daily: [
          {
            id: 'daily_checkin',
            completed: true,
            canClaim: true,
            progress: 1
          }
        ],
        weekly: [{ id: 'weekly_checkin', completed: false, canClaim: false, progress: 0 }],
        dailyPeriodKey: 'd',
        weeklyPeriodKey: 'w'
      })
    }));
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/pool.js');
    vi.doUnmock('../../../../server/modules/checkin/services/premium-policy.js');
    vi.doUnmock('../../../../server/modules/wallet/services/wallet-worker-client.js');
    vi.doUnmock('../../../../server/modules/mining-engine/services/mining-worker-client.js');
  });

  describe('ensureQuestSchema', () => {
    it('semeia as definições default via INSERT ON CONFLICT DO NOTHING', async () => {
      const { ensureQuestSchema } = await import('../../../../server/modules/quests/services/quest.js');
      await ensureQuestSchema();
      const inserts = client.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO quest_definitions'));
      expect(inserts.length).toBe(6); // DEFAULT_QUEST_DEFINITIONS tem 6 entradas
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('cacheia em memória: 2ª chamada não repete os upserts nem abre nova conexão', async () => {
      const { ensureQuestSchema } = await import('../../../../server/modules/quests/services/quest.js');
      await ensureQuestSchema();
      await ensureQuestSchema();
      expect(dbMock.default.connect).toHaveBeenCalledTimes(1);
    });

    it('falha na 1ª tentativa não fica cacheada: 2ª chamada tenta de novo', async () => {
      const failingClient = { query: vi.fn().mockRejectedValue(new Error('conexão perdida')), release: vi.fn() };
      dbMock.default.connect = vi.fn().mockResolvedValueOnce(failingClient).mockResolvedValueOnce(client);
      const { ensureQuestSchema } = await import('../../../../server/modules/quests/services/quest.js');
      await expect(ensureQuestSchema()).rejects.toThrow('conexão perdida');
      await expect(ensureQuestSchema()).resolves.toBeUndefined();
      expect(dbMock.default.connect).toHaveBeenCalledTimes(2);
    });
  });

  describe('bumpQuestProgress', () => {
    it('userId inválido: não faz nada', async () => {
      const { bumpQuestProgress } = await import('../../../../server/modules/quests/services/quest.js');
      await bumpQuestProgress(-1, 'checkin', 1);
      expect(client.query).not.toHaveBeenCalled();
    });

    it('amount <= 0: não faz nada', async () => {
      const { bumpQuestProgress } = await import('../../../../server/modules/quests/services/quest.js');
      await bumpQuestProgress(1, 'checkin', 0);
      expect(client.query).not.toHaveBeenCalled();
    });

    it('incrementa progresso das quests do actionType (daily + weekly)', async () => {
      client.query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s.includes('SELECT progress, completed_at, claimed_at')) {
          return { rows: [{ progress: 0, completed_at: null, claimed_at: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      const { bumpQuestProgress } = await import('../../../../server/modules/quests/services/quest.js');
      await bumpQuestProgress(1, 'checkin', 1);
      const updates = client.query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE user_quest_progress'));
      expect(updates).toHaveLength(2); // daily_checkin + weekly_checkin
      expect(client.query).toHaveBeenCalledWith('COMMIT');
    });

    it('quest já resgatada (claimed_at != null) não é actualizada de novo', async () => {
      client.query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s.includes('SELECT progress, completed_at, claimed_at')) {
          return { rows: [{ progress: 1, completed_at: 1000, claimed_at: 2000 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      const { bumpQuestProgress } = await import('../../../../server/modules/quests/services/quest.js');
      await bumpQuestProgress(1, 'checkin', 1);
      const updates = client.query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE user_quest_progress'));
      expect(updates).toHaveLength(0);
    });

    it('erro na transação: ROLLBACK e não propaga (best-effort)', async () => {
      client.query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s === 'BEGIN') return undefined;
        if (s.includes('INSERT INTO user_quest_progress')) throw new Error('db down');
        return { rows: [], rowCount: 0 };
      });
      const { bumpQuestProgress } = await import('../../../../server/modules/quests/services/quest.js');
      await expect(bumpQuestProgress(1, 'checkin', 1)).resolves.toBeUndefined();
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('claimQuestReward', () => {
    it('questId vazio: BAD_QUEST (sem chamar worker)', async () => {
      const { claimQuestReward } = await import('../../../../server/modules/quests/services/quest.js');
      const out = await claimQuestReward(1, '');
      expect(out).toMatchObject({ ok: false, code: 'BAD_QUEST' });
      expect(callWalletQuestClaim).not.toHaveBeenCalled();
    });

    it('delega domain errors do worker', async () => {
      callWalletQuestClaim.mockResolvedValue({ ok: false, error: 'Quest not found.', code: 'NOT_FOUND' });
      const { claimQuestReward } = await import('../../../../server/modules/quests/services/quest.js');
      const out = await claimQuestReward(1, 'nao_existe');
      expect(out).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });

    it('NO_PROGRESS / INCOMPLETE / ALREADY_CLAIMED via worker', async () => {
      callWalletQuestClaim.mockResolvedValueOnce({ ok: false, error: 'No progress on this quest yet.', code: 'NO_PROGRESS' });
      callWalletQuestClaim.mockResolvedValueOnce({ ok: false, error: 'Quest still incomplete.', code: 'INCOMPLETE' });
      callWalletQuestClaim.mockResolvedValueOnce({ ok: false, error: 'Reward already claimed.', code: 'ALREADY_CLAIMED' });
      const { claimQuestReward } = await import('../../../../server/modules/quests/services/quest.js');
      expect(await claimQuestReward(1, 'daily_checkin')).toMatchObject({ code: 'NO_PROGRESS' });
      expect(await claimQuestReward(1, 'weekly_checkin')).toMatchObject({ code: 'INCOMPLETE' });
      expect(await claimQuestReward(1, 'daily_checkin')).toMatchObject({ code: 'ALREADY_CLAIMED' });
    });

    it('sucesso: devolve rewardUsdc + newUsdc do worker', async () => {
      callWalletQuestClaim.mockResolvedValue({ ok: true, rewardUsdc: 0.05, newUsdc: 5.05 });
      const { claimQuestReward } = await import('../../../../server/modules/quests/services/quest.js');
      const out = await claimQuestReward(1, 'daily_checkin');
      expect(out).toMatchObject({ ok: true, rewardUsdc: 0.05, newUsdc: 5.05 });
      expect(callWalletQuestClaim).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, questId: 'daily_checkin', serverNowMs: expect.any(Number) })
      );
    });

    it('reward 0: worker devolve newUsdc sem crédito', async () => {
      callWalletQuestClaim.mockResolvedValue({ ok: true, rewardUsdc: 0, newUsdc: 3 });
      const { claimQuestReward } = await import('../../../../server/modules/quests/services/quest.js');
      const out = await claimQuestReward(1, 'daily_checkin');
      expect(out).toMatchObject({ ok: true, rewardUsdc: 0, newUsdc: 3 });
    });

    it('GENESIS_WALLET_URL unset: propaga throw', async () => {
      callWalletQuestClaim.mockRejectedValue(new Error('GENESIS_WALLET_URL unset'));
      const { claimQuestReward } = await import('../../../../server/modules/quests/services/quest.js');
      await expect(claimQuestReward(1, 'daily_checkin')).rejects.toThrow('GENESIS_WALLET_URL unset');
    });
  });

  describe('getQuestsState', () => {
    it('delega ao genesis-mining-worker', async () => {
      const { getQuestsState } = await import('../../../../server/modules/quests/services/quest.js');
      const state = await getQuestsState(1, Date.now());
      const dailyCheckin = state.daily.find((d) => d.id === 'daily_checkin')!;
      expect(dailyCheckin.completed).toBe(true);
      expect(dailyCheckin.canClaim).toBe(true);
    });
  });
});
