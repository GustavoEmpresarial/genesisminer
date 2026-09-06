import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HARDWARE_URL = 'http://hw.test';
const HARDWARE_CLIENT_PATH = '../../../../server/modules/hardware/services/hardware-client.js';

describe('wheel services/promo-redeem', () => {
  let grantMock: Record<string, any>;
  let callHardwareCredit: ReturnType<typeof vi.fn>;
  let prevHardwareUrl: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    prevHardwareUrl = process.env.GENESIS_HARDWARE_URL;
    process.env.GENESIS_HARDWARE_URL = HARDWARE_URL;
    callHardwareCredit = vi.fn().mockResolvedValue({ ok: true });
    grantMock = { materializeUpgradePackageAsLootBoxInTx: vi.fn().mockResolvedValue({ boxId: 'box_1', boxName: 'Pacote' }) };
    vi.doMock('../../../../server/modules/upgrades/services/grant.js', () => grantMock);
    vi.doMock(HARDWARE_CLIENT_PATH, () => ({
      hardwareWorkerBaseUrl: () => HARDWARE_URL,
      callHardwareCredit
    }));
  });

  afterEach(() => {
    if (prevHardwareUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
    else process.env.GENESIS_HARDWARE_URL = prevHardwareUrl;
    vi.doUnmock('../../../../server/modules/upgrades/services/grant.js');
    vi.doUnmock(HARDWARE_CLIENT_PATH);
  });

  function baseTx(overrides: Record<string, any> = {}) {
    return {
      promo_codes: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      promo_code_redemptions: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(undefined) },
      unopened_boxes: { upsert: vi.fn().mockResolvedValue(undefined), findMany: vi.fn().mockResolvedValue([]) },
      stock: { upsert: vi.fn().mockResolvedValue(undefined), findMany: vi.fn().mockResolvedValue([]) },
      ...overrides
    };
  }

  it('lança 404 quando o código não existe', async () => {
    const tx = baseTx({ promo_codes: { findUnique: vi.fn().mockResolvedValue(null) } });
    const { runPromoCodeRedeemInTransaction } = await import('../../../../server/modules/wheel/services/promo-redeem.js');
    try {
      await runPromoCodeRedeemInTransaction(tx as any, { userId: 1, normalizedCode: 'NOPE', serverNowMs: Date.now() });
      expect.unreachable();
    } catch (e: any) {
      expect(e.statusCode).toBe(404);
    }
  });

  it('lança 400 quando o usuário já resgatou (não-roleta)', async () => {
    const tx = baseTx({
      promo_codes: { findUnique: vi.fn().mockResolvedValue({ code: 'C1', type: 'shop', is_active: 1, loot_box_id: null, upgrade_id: null, admin_upgrade_id: null, expires_at: null }) },
      promo_code_redemptions: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue({ reward_granted: 1 }), create: vi.fn() }
    });
    const { runPromoCodeRedeemInTransaction } = await import('../../../../server/modules/wheel/services/promo-redeem.js');
    try {
      await runPromoCodeRedeemInTransaction(tx as any, { userId: 1, normalizedCode: 'C1', serverNowMs: Date.now() });
      expect.unreachable();
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
    }
  });

  it('código roleta_ novo: cria redemption com reward_granted=0 e devolve kind roleta_new', async () => {
    const tx = baseTx({
      promo_codes: { findUnique: vi.fn().mockResolvedValue({ code: 'C1', type: 'roleta_player_1x', is_active: 1, loot_box_id: null, upgrade_id: null, admin_upgrade_id: null, expires_at: null }) },
      $queryRaw: vi.fn().mockResolvedValue([{ code: 'C1', type: 'roleta_player_1x', is_active: 1, loot_box_id: null, upgrade_id: null, admin_upgrade_id: null, expires_at: null }])
    });
    const { runPromoCodeRedeemInTransaction } = await import('../../../../server/modules/wheel/services/promo-redeem.js');
    const out = await runPromoCodeRedeemInTransaction(tx as any, { userId: 1, normalizedCode: 'C1', serverNowMs: Date.now() });
    expect(out).toMatchObject({ kind: 'roleta_new', code: 'C1' });
    expect(tx.promo_code_redemptions.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reward_granted: 0 }) }));
  });

  it('admin_upgrade_id: materializa pacote como caixa via materializeUpgradePackageAsLootBoxInTx', async () => {
    const tx = baseTx({
      promo_codes: {
        findUnique: vi.fn().mockResolvedValue({ code: 'C2', type: 'standard', is_active: 1, loot_box_id: null, upgrade_id: null, admin_upgrade_id: 'pkg_1', expires_at: null })
      }
    });
    const { runPromoCodeRedeemInTransaction } = await import('../../../../server/modules/wheel/services/promo-redeem.js');
    const out = await runPromoCodeRedeemInTransaction(tx as any, { userId: 1, normalizedCode: 'C2', serverNowMs: Date.now() });
    expect(out.kind).toBe('standard');
    expect(grantMock.materializeUpgradePackageAsLootBoxInTx).toHaveBeenCalledWith(tx, { userId: 1, upgradeId: 'pkg_1' });
  });

  it('GENESIS_HARDWARE_URL: upgrade_id via callHardwareCredit — sem upsert stock', async () => {
    const tx = baseTx({
      promo_codes: {
        findUnique: vi.fn().mockResolvedValue({
          code: 'C3',
          type: 'standard',
          is_active: 1,
          loot_box_id: null,
          upgrade_id: 'gpu_1',
          admin_upgrade_id: null,
          expires_at: null
        })
      }
    });
    const { runPromoCodeRedeemInTransaction } = await import('../../../../server/modules/wheel/services/promo-redeem.js');
    const out = await runPromoCodeRedeemInTransaction(tx as never, { userId: 1, normalizedCode: 'C3', serverNowMs: Date.now() });
    expect(out.kind).toBe('standard');
    expect(callHardwareCredit).toHaveBeenCalledTimes(1);
    expect(callHardwareCredit).toHaveBeenCalledWith({ userId: 1, itemId: 'gpu_1', qty: 1 });
    expect(tx.stock.upsert).not.toHaveBeenCalled();
  });
});
