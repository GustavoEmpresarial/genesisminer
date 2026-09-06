import { describe, expect, it } from 'vitest';
import { deriveActivityReasons, mergeEmailAndActivityReasons, type UserActivitySignals } from '../../../../../server/modules/admin/suspicious-emails/services/signals.js';

function baseSignals(overrides: Partial<UserActivitySignals> = {}): UserActivitySignals {
  return {
    coinBalanceSum: 0,
    racksMiningOn: 0,
    rackCount: 0,
    hasStock: false,
    totalUsdcDeposited: 0,
    hasWallet: false,
    referredBy: null,
    lastLoginMs: Date.now(),
    accountStartMs: Date.now(),
    lastCheckinMs: null,
    ...overrides
  };
}

describe('admin/suspicious-emails services/signals', () => {
  describe('deriveActivityReasons', () => {
    it('nunca minerou (sem coins/racks/hash): never_mined + zero_hash', () => {
      const out = deriveActivityReasons(baseSignals(), null);
      expect(out).toContain('never_mined');
      expect(out).toContain('zero_hash');
    });

    it('com saldo de moedas: não marca never_mined', () => {
      const out = deriveActivityReasons(baseSignals({ coinBalanceSum: 1 }), null);
      expect(out).not.toContain('never_mined');
    });

    it('com totalHashFromSnapshot > 0: não marca never_mined mesmo com saldos zerados', () => {
      const out = deriveActivityReasons(baseSignals(), 100);
      expect(out).not.toContain('never_mined');
    });

    it('sem wallet: no_wallet', () => {
      expect(deriveActivityReasons(baseSignals({ hasWallet: false }), null)).toContain('no_wallet');
      expect(deriveActivityReasons(baseSignals({ hasWallet: true }), null)).not.toContain('no_wallet');
    });

    it('sem depósito: no_deposit', () => {
      expect(deriveActivityReasons(baseSignals({ totalUsdcDeposited: 0 }), null)).toContain('no_deposit');
      expect(deriveActivityReasons(baseSignals({ totalUsdcDeposited: 10 }), null)).not.toContain('no_deposit');
    });

    it('referral_only: veio de indicação, sem minerar/wallet/depósito', () => {
      const out = deriveActivityReasons(baseSignals({ referredBy: 'outro-user' }), null);
      expect(out).toContain('referral_only');
    });

    it('não marca referral_only se já minerou', () => {
      const out = deriveActivityReasons(baseSignals({ referredBy: 'outro-user', coinBalanceSum: 5 }), null);
      expect(out).not.toContain('referral_only');
    });

    it('login há mais de 90 dias: inactive_account', () => {
      const oldLogin = Date.now() - 91 * 24 * 60 * 60 * 1000;
      const out = deriveActivityReasons(baseSignals({ lastLoginMs: oldLogin }), null);
      expect(out).toContain('inactive_account');
    });

    it('login recente: não marca inactive_account', () => {
      const out = deriveActivityReasons(baseSignals({ lastLoginMs: Date.now() }), null);
      expect(out).not.toContain('inactive_account');
    });

    it('sem progresso nenhum (racks/stock/saldo/depósito/checkin): no_game_progress', () => {
      const out = deriveActivityReasons(baseSignals({ lastLoginMs: Date.now() }), null);
      expect(out).toContain('no_game_progress');
    });

    it('conta morta: nunca minerou + sem wallet + sem depósito + inactive + sem progresso', () => {
      const oldTs = Date.now() - 91 * 24 * 60 * 60 * 1000;
      const out = deriveActivityReasons(baseSignals({ lastLoginMs: oldTs, accountStartMs: oldTs }), null);
      expect(out).toContain('dead_account');
    });

    it('conta com actividade recente e progresso: não é dead_account', () => {
      const out = deriveActivityReasons(baseSignals({ coinBalanceSum: 5, hasWallet: true, totalUsdcDeposited: 10 }), null);
      expect(out).not.toContain('dead_account');
    });
  });

  describe('mergeEmailAndActivityReasons', () => {
    it('junta motivos de email + actividade sem duplicar', () => {
      const merged = mergeEmailAndActivityReasons(['temporary_domain', 'no_wallet'], baseSignals({ hasWallet: false }), null);
      expect(merged.filter((r) => r === 'no_wallet')).toHaveLength(1);
      expect(merged).toContain('temporary_domain');
    });
  });
});
