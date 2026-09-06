/**
 * Compra atómica de pacote admin (Upgrades) via `genesis-hardware`
 * (`POST /v1/upgrades/purchase`): idempotência, versão, visibilidade, stock,
 * USDC debit + materialize loot box + `upgrade_purchase_idempotency` num TX.
 *
 * Fail-closed — sem fallback Prisma money TX quando `GENESIS_HARDWARE_URL` unset.
 *
 * ⚠️ Correção de segurança (DECISIONS.md #8): `admin_upgrade_visibility` é
 * conferida no worker antes de debitar (antes só na listagem).
 */
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import { stableIntentFingerprint } from '../../../shared/security/stable-fingerprint.js';
import {
  callUpgradePackagePurchase,
  isHardwareMarketError
} from '../../hardware/services/hardware-client.js';
import { parseUpgradePackageId } from './catalog.js';

const HTTP_BAD_REQUEST = 400;

export type UpgradePurchaseOk = {
  ok: true;
  newUsdc: number;
  idempotentReplay: boolean;
  packageVersion: number;
  /** Caixa criada para o pacote (`Caixas da Sorte`). */
  box?: { id: string; name: string; quantity: number };
};

/** Fingerprint do pedido (pacote + versão opcional declarada pelo cliente). */
export function upgradePurchaseRequestFingerprint(packageId: string, clientPackageVersion: number | null | undefined): string {
  return stableIntentFingerprint({
    op: 'upgrade_package_purchase',
    packageId: String(packageId || '').trim(),
    clientPackageVersion: clientPackageVersion != null && Number.isFinite(clientPackageVersion) ? clientPackageVersion : null
  });
}

/**
 * Compra atómica de pacote admin via worker fail-closed.
 *
 * Quando `idempotencyKey` é `null`, o worker não grava/replay em
 * `upgrade_purchase_idempotency` (compat. rota legada).
 */
export async function runUpgradePackagePurchase(args: {
  userId: number;
  packageIdRaw: unknown;
  /** Quando `null`, não grava/replay em `upgrade_purchase_idempotency` (compat. rota legada). */
  idempotencyKey: string | null;
  clientPackageVersion: number | null | undefined;
  nowMs?: number;
}): Promise<UpgradePurchaseOk> {
  const pkgId = parseUpgradePackageId(args.packageIdRaw);
  if (!pkgId) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { ok: false, error: 'Invalid package.' });
  }

  try {
    return await callUpgradePackagePurchase({
      userId: args.userId,
      packageId: pkgId,
      idempotencyKey: args.idempotencyKey,
      clientPackageVersion: args.clientPackageVersion ?? null,
      serverNowMs: args.nowMs
    });
  } catch (e) {
    if (isHardwareMarketError(e)) {
      throw new HttpControlledError(e.statusCode, { ok: false, ...e.jsonBody });
    }
    throw e;
  }
}
