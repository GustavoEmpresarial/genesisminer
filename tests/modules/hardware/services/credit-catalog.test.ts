import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const HARDWARE_URL = 'http://hw.test';

describe('hardware services/credit-catalog', () => {
  let prevHardwareUrl: string | undefined;

  beforeEach(() => {
    prevHardwareUrl = process.env.GENESIS_HARDWARE_URL;
    process.env.GENESIS_HARDWARE_URL = HARDWARE_URL;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHardwareUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
    else process.env.GENESIS_HARDWARE_URL = prevHardwareUrl;
    vi.doUnmock('../../../../server/modules/hardware/services/hardware-client.js');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function makeTx() {
    return {
      stock: { upsert: vi.fn().mockResolvedValue({}) },
      upgrades: { findUnique: vi.fn().mockResolvedValue(null) },
      player_asic_leases: { create: vi.fn().mockResolvedValue({}) },
      item_instances: { create: vi.fn().mockResolvedValue({}) }
    };
  }

  it('qty inválida: skipped sem side-effects', async () => {
    const callHardwareCredit = vi.fn();
    vi.doMock('../../../../server/modules/hardware/services/hardware-client.js', () => ({
      hardwareWorkerBaseUrl: () => HARDWARE_URL,
      callHardwareCredit
    }));
    const { creditCatalogItemQtyInTx } = await import(
      '../../../../server/modules/hardware/services/credit-catalog.js'
    );
    const tx = makeTx();
    expect(await creditCatalogItemQtyInTx(tx as never, 1, 'x', 0)).toBe('skipped');
    expect(await creditCatalogItemQtyInTx(tx as never, 1, '', 5)).toBe('skipped');
    expect(callHardwareCredit).not.toHaveBeenCalled();
    expect(tx.stock.upsert).not.toHaveBeenCalled();
    expect(tx.player_asic_leases.create).not.toHaveBeenCalled();
    expect(tx.item_instances.create).not.toHaveBeenCalled();
  });

  it('GENESIS_HARDWARE_URL: só callHardwareCredit — sem Prisma stock nem leases', async () => {
    const callHardwareCredit = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock('../../../../server/modules/hardware/services/hardware-client.js', () => ({
      hardwareWorkerBaseUrl: () => HARDWARE_URL,
      callHardwareCredit
    }));
    const { creditCatalogItemQtyInTx } = await import(
      '../../../../server/modules/hardware/services/credit-catalog.js'
    );
    const tx = makeTx();
    const qty = 6;
    const kind = await creditCatalogItemQtyInTx(tx as never, 11915, 'dolar_f2p2', qty);

    expect(kind).toBe('stock');
    expect(callHardwareCredit).toHaveBeenCalledTimes(1);
    expect(callHardwareCredit).toHaveBeenCalledWith({ userId: 11915, itemId: 'dolar_f2p2', qty });
    expect(tx.stock.upsert).not.toHaveBeenCalled();
    expect(tx.upgrades.findUnique).not.toHaveBeenCalled();
    expect(tx.player_asic_leases.create).not.toHaveBeenCalled();
    expect(tx.item_instances.create).not.toHaveBeenCalled();
  });

  it('GENESIS_HARDWARE_URL unset: throw GENESIS_HARDWARE_URL unset', async () => {
    delete process.env.GENESIS_HARDWARE_URL;
    const { creditCatalogItemQtyInTx } = await import(
      '../../../../server/modules/hardware/services/credit-catalog.js'
    );
    const tx = makeTx();
    await expect(creditCatalogItemQtyInTx(tx as never, 1, 'gpu_1', 1)).rejects.toThrow(
      'GENESIS_HARDWARE_URL unset'
    );
    expect(tx.stock.upsert).not.toHaveBeenCalled();
  });
});
