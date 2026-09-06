import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('modules/profile/services/referral-credit', () => {
  let tx: {
    users: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    referrals: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
    game_states: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
    $executeRaw: ReturnType<typeof vi.fn>;
  };
  let callWalletReferralCreditOnEmailVerified: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    tx = {
      users: { findUnique: vi.fn(), findFirst: vi.fn() },
      referrals: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(undefined) },
      game_states: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue(undefined) },
      $executeRaw: vi.fn().mockResolvedValue(undefined)
    };
    callWalletReferralCreditOnEmailVerified = vi.fn().mockResolvedValue({ ok: true, skipped: true });
    vi.doMock('../../../../server/modules/wallet/services/wallet-worker-client.js', () => ({
      callWalletReferralCreditOnEmailVerified
    }));
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/wallet/services/wallet-worker-client.js');
    vi.restoreAllMocks();
  });

  async function load() {
    return import('../../../../server/modules/profile/services/referral-credit.js');
  }

  describe('bindReferralAndAccrueClaim', () => {
    it('já existe vínculo (mesmo par referrer+username): não duplica nem re-incrementa', async () => {
      tx.referrals.findFirst.mockResolvedValue({ id: 1 });
      const { bindReferralAndAccrueClaim } = await load();
      await bindReferralAndAccrueClaim(tx as never, { referrerId: 2, referredUsername: 'bob' });
      expect(tx.referrals.create).not.toHaveBeenCalled();
      expect(tx.game_states.upsert).not.toHaveBeenCalled();
    });

    it('caminho feliz: cria o vínculo e soma 1 em claimed_referrals do indicador', async () => {
      const { bindReferralAndAccrueClaim } = await load();
      await bindReferralAndAccrueClaim(tx as never, { referrerId: 2, referredUsername: 'bob' });
      expect(tx.$executeRaw).toHaveBeenCalled();
      expect(tx.referrals.create).toHaveBeenCalledWith({ data: { user_id: 2, referred_username: 'bob' } });
      expect(tx.game_states.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { user_id: 2 }, update: expect.objectContaining({ claimed_referrals: { increment: 1 } }) })
      );
    });

    it('adquire advisory lock antes do findFirst (serializa corrida findFirst→create)', async () => {
      const order: string[] = [];
      tx.$executeRaw.mockImplementation(async () => {
        order.push('lock');
      });
      tx.referrals.findFirst.mockImplementation(async () => {
        order.push('find');
        return null;
      });
      tx.referrals.create.mockImplementation(async () => {
        order.push('create');
      });
      const { bindReferralAndAccrueClaim } = await load();
      await bindReferralAndAccrueClaim(tx as never, { referrerId: 2, referredUsername: 'bob' });
      expect(order.slice(0, 3)).toEqual(['lock', 'find', 'create']);
    });

    it('referrerId inválido ou username vazio: no-op sem tocar na BD', async () => {
      const { bindReferralAndAccrueClaim } = await load();
      await bindReferralAndAccrueClaim(tx as never, { referrerId: 0, referredUsername: 'bob' });
      await bindReferralAndAccrueClaim(tx as never, { referrerId: 2, referredUsername: '   ' });
      expect(tx.referrals.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('creditReferralBonusOnEmailVerified', () => {
    it('delega ao wallet worker (fail-closed)', async () => {
      callWalletReferralCreditOnEmailVerified.mockResolvedValue({ ok: true, creditedUsdc: 1 });
      const { creditReferralBonusOnEmailVerified } = await load();
      await creditReferralBonusOnEmailVerified(42);
      expect(callWalletReferralCreditOnEmailVerified).toHaveBeenCalledWith(
        expect.objectContaining({ verifiedUserId: 42, serverNowMs: expect.any(Number) })
      );
    });

    it('propaga GENESIS_WALLET_URL unset', async () => {
      callWalletReferralCreditOnEmailVerified.mockRejectedValue(new Error('GENESIS_WALLET_URL unset'));
      const { creditReferralBonusOnEmailVerified } = await load();
      await expect(creditReferralBonusOnEmailVerified(1)).rejects.toThrow('GENESIS_WALLET_URL unset');
    });
  });
});
