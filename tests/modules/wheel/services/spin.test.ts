import { describe, expect, it, vi, beforeEach } from 'vitest';

describe('wheel services/spin — paidWheelSpinAtomic', () => {
  let callWheelPaidSpin: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    callWheelPaidSpin = vi.fn();
    vi.doMock('../../../../server/modules/hardware/services/hardware-client.js', () => ({
      callWheelPaidSpin,
      isHardwareMarketError: (e: unknown) =>
        Boolean(e && typeof e === 'object' && (e as { name?: string }).name === 'HardwareMarketError')
    }));
  });

  it('sucesso: chama callWheelPaidSpin (worker TX)', async () => {
    callWheelPaidSpin.mockResolvedValue({
      ok: true,
      spinId: 's1',
      wonItemId: 'upg_x',
      item: { id: 'p1', label: 'X', weight: 10, color: null, item_id: 'upg_x', image: null },
      newUsdc: 9,
      chargedUsdc: 0.1,
      boxId: 'b1',
      boxName: 'Prêmio: X',
      idempotentReplay: false
    });
    const { paidWheelSpinAtomic } = await import('../../../../server/modules/wheel/services/spin.js');
    const result = await paidWheelSpinAtomic({ userId: 1, serverNowMs: Date.now(), idempotencyKey: 'k'.repeat(10) });
    expect(result.wonItemId).toBe('upg_x');
    expect(result.idempotentReplay).toBe(false);
    expect(callWheelPaidSpin).toHaveBeenCalledTimes(1);
    expect(callWheelPaidSpin).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, idempotencyKey: 'k'.repeat(10) })
    );
  });

  it('replay idempotente: devolve payload do worker com idempotentReplay', async () => {
    callWheelPaidSpin.mockResolvedValue({
      ok: true,
      spinId: 's1',
      wonItemId: 'upg_x',
      item: null,
      newUsdc: 9,
      chargedUsdc: 0.1,
      boxId: 'b1',
      boxName: 'B',
      idempotentReplay: true
    });
    const { paidWheelSpinAtomic } = await import('../../../../server/modules/wheel/services/spin.js');
    const result = await paidWheelSpinAtomic({ userId: 1, serverNowMs: Date.now(), idempotencyKey: 'k'.repeat(10) });
    expect(result.idempotentReplay).toBe(true);
  });

  it('propaga HardwareMarketError como HttpControlledError', async () => {
    const err = Object.assign(new Error('Insufficient USDC for a spin (0.10 USDC per spin).'), {
      name: 'HardwareMarketError',
      statusCode: 422,
      jsonBody: { error: 'Insufficient USDC for a spin (0.10 USDC per spin).' }
    });
    callWheelPaidSpin.mockRejectedValue(err);
    const { paidWheelSpinAtomic } = await import('../../../../server/modules/wheel/services/spin.js');
    await expect(
      paidWheelSpinAtomic({ userId: 1, serverNowMs: Date.now(), idempotencyKey: 'k'.repeat(10) })
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('wheel services/spin — wheelRollInTransaction / roletaClaim', () => {
  const PRIZE_ROW = {
    id: 'p1',
    stored_label: 'Prêmio X',
    weight: 10,
    color: null,
    item_id: 'upg_x',
    upgrade_name: null,
    upgrade_image: null
  };

  function baseTx(overrides: Record<string, unknown> = {}) {
    return {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      $queryRaw: vi.fn().mockResolvedValue([]),
      loot_boxes: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(undefined),
        findUnique: vi.fn().mockResolvedValue({ name: 'Prêmio: Upgrade X' })
      },
      loot_box_items: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(undefined) },
      unopened_boxes: { upsert: vi.fn().mockResolvedValue(undefined) },
      promo_code_redemptions: { updateMany: vi.fn(), findUnique: vi.fn() },
      ...overrides
    };
  }

  it('rejeita 400 quando o código ainda não foi resgatado', async () => {
    const { wheelRollInTransaction } = await import('../../../../server/modules/wheel/services/spin.js');
    const tx = baseTx();
    try {
      await wheelRollInTransaction(tx as never, { userId: 1, normalizedCode: 'CODE1', serverNowMs: Date.now() });
      expect.unreachable();
    } catch (e: unknown) {
      expect((e as { statusCode: number }).statusCode).toBe(400);
    }
  });

  it('sorteia e atualiza a redemption quando ainda não tem won_item_id', async () => {
    const { wheelRollInTransaction } = await import('../../../../server/modules/wheel/services/spin.js');
    const tx = baseTx();
    tx.$queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('FROM promo_code_redemptions')) return [{ reward_granted: 0, won_item_id: null }];
      if (sql.includes('FROM promo_codes')) return [{ type: 'roleta_player_1x', loot_box_id: null, expires_at: null }];
      if (sql.includes('FROM wheel_prizes')) return [PRIZE_ROW];
      return [];
    });
    (tx.promo_code_redemptions as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mockResolvedValue({ count: 1 });
    const result = await wheelRollInTransaction(tx as never, { userId: 1, normalizedCode: 'CODE1', serverNowMs: Date.now() });
    expect(result.idempotent).toBe(false);
    expect(result.wonItemId).toBe('upg_x');
  });

  it('rejeita 403 quando o item reivindicado não bate com o sorteado', async () => {
    const { roletaClaimInTransaction } = await import('../../../../server/modules/wheel/services/spin.js');
    const tx = baseTx();
    tx.$queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('FROM promo_code_redemptions')) return [{ reward_granted: 0, won_item_id: 'upg_real' }];
      return [];
    });
    try {
      await roletaClaimInTransaction(tx as never, {
        userId: 1,
        normalizedCode: 'CODE1',
        wonItemId: 'upg_fake',
        serverNowMs: Date.now()
      });
      expect.unreachable();
    } catch (e: unknown) {
      expect((e as { statusCode: number }).statusCode).toBe(403);
    }
  });
});
