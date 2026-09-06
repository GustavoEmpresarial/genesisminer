import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = { id: 1, username: 'alice', email: 'alice@x.com', referral_code: 'ALICE1', referred_by: null };
const USER_B = { id: 2, username: 'bob', email: 'bob@x.com', referral_code: 'BOB1', referred_by: 'alice' };
const USER_C = { id: 3, username: 'carol', email: 'carol@x.com', referral_code: 'CAROL1', referred_by: 'bob' };

describe('admin/referral services/network', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        $queryRaw: vi.fn().mockResolvedValue([]),
        users: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }
      }
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  describe('parseLookupQueries', () => {
    it('separa por vírgula/ponto-e-vírgula/quebra de linha, dedup e trim', async () => {
      const { parseLookupQueries } = await import('../../../../../server/modules/admin/referral/services/network.js');
      expect(parseLookupQueries('a, b;c\nb')).toEqual(['a', 'b', 'c']);
    });

    it('vazio/null devolve []', async () => {
      const { parseLookupQueries } = await import('../../../../../server/modules/admin/referral/services/network.js');
      expect(parseLookupQueries(null)).toEqual([]);
      expect(parseLookupQueries('   ')).toEqual([]);
    });

    it('limita a 50 entradas', async () => {
      const { parseLookupQueries } = await import('../../../../../server/modules/admin/referral/services/network.js');
      const many = Array.from({ length: 60 }, (_, i) => `u${i}`).join(',');
      expect(parseLookupQueries(many)).toHaveLength(50);
    });
  });

  describe('toReferralUserBrief', () => {
    it('mapeia os campos, devolve null se row for null', async () => {
      const { toReferralUserBrief } = await import('../../../../../server/modules/admin/referral/services/network.js');
      expect(toReferralUserBrief(USER_A)).toEqual({ id: 1, username: 'alice', email: 'alice@x.com', referralCode: 'ALICE1' });
      expect(toReferralUserBrief(null)).toBeNull();
    });
  });

  describe('findUserByLookupToken', () => {
    it('token vazio: devolve null sem consultar', async () => {
      const { findUserByLookupToken } = await import('../../../../../server/modules/admin/referral/services/network.js');
      expect(await findUserByLookupToken('  ')).toBeNull();
      expect(prismaMock.prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('devolve a primeira linha encontrada', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([USER_A]);
      const { findUserByLookupToken } = await import('../../../../../server/modules/admin/referral/services/network.js');
      expect(await findUserByLookupToken('alice')).toEqual(USER_A);
    });
  });

  describe('buildReferrerChain', () => {
    it('sobe a cadeia de indicadores até não haver mais referred_by', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValueOnce([USER_B]).mockResolvedValueOnce([USER_A]);
      const { buildReferrerChain } = await import('../../../../../server/modules/admin/referral/services/network.js');
      const chain = await buildReferrerChain(USER_C);
      expect(chain.map((u) => u.username)).toEqual(['bob', 'alice']);
    });

    it('detecta ciclo (já visto) e pára', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([USER_C]);
      const { buildReferrerChain } = await import('../../../../../server/modules/admin/referral/services/network.js');
      const chain = await buildReferrerChain(USER_C);
      expect(chain).toEqual([]);
    });
  });

  describe('resolveNetworkTarget', () => {
    it('tenta userId, depois email, depois username, nessa ordem', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([USER_B]);
      const { resolveNetworkTarget } = await import('../../../../../server/modules/admin/referral/services/network.js');
      const out = await resolveNetworkTarget({ userId: '999', email: 'bob@x.com' });
      expect(out).toEqual(USER_B);
    });

    it('sem nenhum campo: devolve null', async () => {
      const { resolveNetworkTarget } = await import('../../../../../server/modules/admin/referral/services/network.js');
      expect(await resolveNetworkTarget({})).toBeNull();
    });
  });

  describe('blockReferralNetwork', () => {
    it('utilizador não encontrado: ok:false', async () => {
      const { blockReferralNetwork } = await import('../../../../../server/modules/admin/referral/services/network.js');
      const out = await blockReferralNetwork({});
      expect(out).toEqual({ ok: false, error: 'Utilizador não encontrado.' });
      expect(prismaMock.prisma.users.updateMany).not.toHaveBeenCalled();
    });

    it('bloqueia o indicador + indicados directos', async () => {
      prismaMock.prisma.$queryRaw
        .mockResolvedValueOnce([USER_A]) // findUserByLookupToken (resolveNetworkTarget via userId)
        .mockResolvedValueOnce([USER_B]) // getReferredNetworkStats rows (listAllReferredUsers)
        .mockResolvedValueOnce([{ link_count: 1, orphan_links: 0 }]) // counts (listAllReferredUsers)
        .mockResolvedValueOnce([USER_B]) // getReferredNetworkStats rows (2nd call)
        .mockResolvedValueOnce([{ link_count: 1, orphan_links: 0 }]); // counts (2nd call)
      const { blockReferralNetwork } = await import('../../../../../server/modules/admin/referral/services/network.js');
      const out = await blockReferralNetwork({ userId: '1' });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.blockedCount).toBe(2);
      }
      expect(prismaMock.prisma.users.updateMany).toHaveBeenCalledWith({ where: { id: { in: [1, 2] } }, data: { is_blocked: 1 } });
    });
  });
});
