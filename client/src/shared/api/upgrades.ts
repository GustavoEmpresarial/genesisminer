/**
 * Upgrades / Eventos e passes — player API.
 * Routes: GET /api/upgrades/state, POST /api/upgrades/purchase
 */
import { apiFetch } from './http';

const base = '/api';

export type UpgradesStatePackagePreview = {
  rewardType: string;
  catalogId: string;
  quantity: number;
  label: string;
  imageUrl: string | null;
  baseProduction: number;
};

const PREVIEW_BASE_PRODUCTION_FALLBACK = 0;

/** Normaliza uma linha de `itemsPreview` vindos do state (campos novos tolerantes). */
export function parseUpgradesStatePackagePreview(raw: unknown): UpgradesStatePackagePreview | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.rewardType !== 'string' || typeof row.catalogId !== 'string') return null;
  if (typeof row.label !== 'string') return null;
  const quantity = Number(row.quantity);
  if (!Number.isFinite(quantity)) return null;
  const imageRaw = row.imageUrl;
  const imageUrl =
    imageRaw == null
      ? null
      : typeof imageRaw === 'string' && imageRaw.trim()
        ? imageRaw.trim()
        : null;
  const bp = Number(row.baseProduction);
  return {
    rewardType: row.rewardType,
    catalogId: row.catalogId,
    quantity,
    label: row.label,
    imageUrl,
    baseProduction: Number.isFinite(bp) ? bp : PREVIEW_BASE_PRODUCTION_FALLBACK
  };
}

export type UpgradesStatePackage = {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  category: string;
  currency: string;
  finalPrice: string;
  originalPrice: string | null;
  discountPercent: number | null;
  version: number;
  isPurchasable: boolean;
  unpurchasableReason: string | null;
  stockRemaining: number | null;
  maxPerUser: number;
  startsAt: number | null;
  endsAt: number | null;
  sortOrder: number;
  alreadyOwned: boolean;
  itemsPreview: UpgradesStatePackagePreview[];
};

export type UpgradesStatePayload = {
  ok: boolean;
  title: string;
  usdcBalance: number;
  categories: string[];
  packages: UpgradesStatePackage[];
  purchaseHistory: Array<{
    upgradeId: string;
    name: string;
    paidUsdc: string;
    purchasedAt: number;
  }>;
  notice?: string;
};

export async function getUpgradesState(): Promise<UpgradesStatePayload | null> {
  try {
    const res = await apiFetch(`${base}/upgrades/state`);
    if (!res.ok) return null;
    const j = (await res.json()) as UpgradesStatePayload;
    if (!j || j.ok !== true) return null;
    return {
      ...j,
      packages: (j.packages || []).map((pkg) => ({
        ...pkg,
        itemsPreview: (pkg.itemsPreview || [])
          .map((row) => parseUpgradesStatePackagePreview(row))
          .filter((row): row is UpgradesStatePackagePreview => row != null)
      }))
    };
  } catch {
    return null;
  }
}

export type UpgradesPurchaseResult =
  | {
      ok: true;
      newUsdc?: number;
      idempotentReplay: boolean;
      packageVersion: number;
      /** Caixa criada para o pacote em Caixas da Sorte. */
      box?: { id: string; name: string; quantity: number };
    }
  | { ok: false; error?: string; status?: number; missing?: number };

/** Compra de pacote (Upgrades) — idempotência obrigatória. */
export async function postUpgradesPurchase(params: {
  packageId: string;
  idempotencyKey: string;
  clientPackageVersion?: number;
}): Promise<UpgradesPurchaseResult> {
  try {
    const res = await apiFetch(`${base}/upgrades/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: params.packageId,
        idempotencyKey: params.idempotencyKey,
        clientPackageVersion: params.clientPackageVersion
      })
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return { ok: false, error: 'Resposta inválida do servidor.', status: res.status };
    }
    if (!res.ok) {
      const missing = typeof json.missing === 'number' ? json.missing : undefined;
      return {
        ok: false,
        error: typeof json.error === 'string' ? json.error : 'Pedido rejeitado.',
        status: res.status,
        missing
      };
    }
    const boxRaw = json.box;
    const box =
      boxRaw && typeof boxRaw === 'object' && boxRaw !== null
        ? {
            id:
              typeof (boxRaw as Record<string, unknown>).id === 'string'
                ? String((boxRaw as Record<string, unknown>).id)
                : '',
            name:
              typeof (boxRaw as Record<string, unknown>).name === 'string'
                ? String((boxRaw as Record<string, unknown>).name)
                : '',
            quantity:
              typeof (boxRaw as Record<string, unknown>).quantity === 'number'
                ? Number((boxRaw as Record<string, unknown>).quantity)
                : 1
          }
        : undefined;
    return {
      ok: true,
      newUsdc: typeof json.newUsdc === 'number' && Number.isFinite(json.newUsdc) ? json.newUsdc : undefined,
      idempotentReplay: json.idempotentReplay === true,
      packageVersion: typeof json.packageVersion === 'number' ? json.packageVersion : 1,
      box: box && box.id ? box : undefined
    };
  } catch {
    return { ok: false, error: 'Erro de rede' };
  }
}
