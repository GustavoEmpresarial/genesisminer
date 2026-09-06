import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('runUpgradePackagePurchase — worker fail-closed', () => {
  let callUpgradePackagePurchase: ReturnType<typeof vi.fn>;
  let HardwareMarketError: new (status: number, body: Record<string, unknown>) => Error & {
    statusCode: number;
    jsonBody: Record<string, unknown>;
  };

  beforeEach(() => {
    vi.resetModules();

    class HME extends Error {
      statusCode: number;
      jsonBody: Record<string, unknown>;
      constructor(statusCode: number, jsonBody: Record<string, unknown>) {
        super(typeof jsonBody.error === 'string' ? jsonBody.error : 'fail');
        this.name = 'HardwareMarketError';
        this.statusCode = statusCode;
        this.jsonBody = jsonBody;
      }
    }
    HardwareMarketError = HME as never;
    callUpgradePackagePurchase = vi.fn().mockResolvedValue({
      ok: true,
      newUsdc: 90,
      idempotentReplay: false,
      packageVersion: 1,
      box: { id: 'box_1', name: 'Pacote 1', quantity: 1 }
    });

    vi.doMock('../../../../server/modules/hardware/services/hardware-client.js', () => ({
      callUpgradePackagePurchase,
      isHardwareMarketError: (e: unknown) => e instanceof HME,
      HardwareMarketError: HME
    }));
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/hardware/services/hardware-client.js');
  });

  const IDEM = 'key12345678';

  it('packageId inválido: 400 sem chamar worker', async () => {
    const { runUpgradePackagePurchase } = await import('../../../../server/modules/upgrades/services/purchase.js');
    await expect(
      runUpgradePackagePurchase({ userId: 1, packageIdRaw: 'id com espaço', idempotencyKey: IDEM, clientPackageVersion: null })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(callUpgradePackagePurchase).not.toHaveBeenCalled();
  });

  it('delega ao hardware worker', async () => {
    const { runUpgradePackagePurchase } = await import('../../../../server/modules/upgrades/services/purchase.js');
    const out = await runUpgradePackagePurchase({
      userId: 1,
      packageIdRaw: 'pack_1',
      idempotencyKey: IDEM,
      clientPackageVersion: null
    });
    expect(out).toMatchObject({
      ok: true,
      newUsdc: 90,
      box: { id: 'box_1', name: 'Pacote 1', quantity: 1 }
    });
    expect(callUpgradePackagePurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        packageId: 'pack_1',
        idempotencyKey: IDEM,
        clientPackageVersion: null
      })
    );
  });

  it('mapeia HardwareMarketError PACKAGE_ACCESS_DENIED → HttpControlledError 403', async () => {
    callUpgradePackagePurchase.mockRejectedValue(
      new HardwareMarketError(403, {
        ok: false,
        error: 'This package is exclusive — your access level does not grant access to it.',
        code: 'PACKAGE_ACCESS_DENIED'
      })
    );
    const { runUpgradePackagePurchase } = await import('../../../../server/modules/upgrades/services/purchase.js');
    await expect(
      runUpgradePackagePurchase({ userId: 1, packageIdRaw: 'pack_1', idempotencyKey: IDEM, clientPackageVersion: null })
    ).rejects.toMatchObject({ statusCode: 403, jsonBody: expect.objectContaining({ code: 'PACKAGE_ACCESS_DENIED' }) });
  });

  it('saldo insuficiente: 422', async () => {
    callUpgradePackagePurchase.mockRejectedValue(
      new HardwareMarketError(422, { ok: false, error: 'Insufficient USDC balance.' })
    );
    const { runUpgradePackagePurchase } = await import('../../../../server/modules/upgrades/services/purchase.js');
    await expect(
      runUpgradePackagePurchase({ userId: 1, packageIdRaw: 'pack_1', idempotencyKey: IDEM, clientPackageVersion: null })
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('versão stale: 409', async () => {
    callUpgradePackagePurchase.mockRejectedValue(
      new HardwareMarketError(409, {
        ok: false,
        error: 'This offer was updated — reload the page and try again.'
      })
    );
    const { runUpgradePackagePurchase } = await import('../../../../server/modules/upgrades/services/purchase.js');
    await expect(
      runUpgradePackagePurchase({ userId: 1, packageIdRaw: 'pack_1', idempotencyKey: IDEM, clientPackageVersion: 99 })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('idempotency payload mismatch: 409', async () => {
    callUpgradePackagePurchase.mockRejectedValue(
      new HardwareMarketError(409, {
        ok: false,
        error: 'Same idempotency key with a different request.',
        code: 'IDEMPOTENCY_PAYLOAD_MISMATCH'
      })
    );
    const { runUpgradePackagePurchase } = await import('../../../../server/modules/upgrades/services/purchase.js');
    await expect(
      runUpgradePackagePurchase({ userId: 1, packageIdRaw: 'pack_1', idempotencyKey: IDEM, clientPackageVersion: null })
    ).rejects.toMatchObject({ statusCode: 409, jsonBody: expect.objectContaining({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' }) });
  });

  it('GENESIS_HARDWARE_URL unset: propaga throw', async () => {
    callUpgradePackagePurchase.mockRejectedValue(new Error('GENESIS_HARDWARE_URL unset'));
    const { runUpgradePackagePurchase } = await import('../../../../server/modules/upgrades/services/purchase.js');
    await expect(
      runUpgradePackagePurchase({ userId: 1, packageIdRaw: 'pack_1', idempotencyKey: IDEM, clientPackageVersion: null })
    ).rejects.toThrow('GENESIS_HARDWARE_URL unset');
  });

  it('upgradePurchaseRequestFingerprint é estável', async () => {
    const { upgradePurchaseRequestFingerprint } = await import('../../../../server/modules/upgrades/services/purchase.js');
    const a = upgradePurchaseRequestFingerprint('pack_1', null);
    const b = upgradePurchaseRequestFingerprint('pack_1', null);
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
    expect(upgradePurchaseRequestFingerprint('pack_1', 1)).not.toBe(a);
  });
});
