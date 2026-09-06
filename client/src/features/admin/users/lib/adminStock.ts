/**
 * Stock helpers for admin user save editor.
 */
export function sanitizeAdminStock(stock: Record<string, number> | undefined): Record<string, number> {
  if (!stock) return {};
  return Object.fromEntries(
    Object.entries(stock).filter(([itemId, qty]) => !itemId.startsWith('temp_legacy_') && Number(qty) > 0)
  );
}

/** Payload de gravação: inclui qty 0 para o backend apagar a linha na conta. */
export function adminStockPayloadForSave(stock: Record<string, number> | undefined): Record<string, number> {
  if (!stock) return {};
  return Object.fromEntries(
    Object.entries(stock)
      .filter(([itemId]) => !itemId.startsWith('temp_legacy_'))
      .map(([itemId, qty]) => {
        const n = Math.floor(Number(qty));
        return [itemId, Number.isFinite(n) && n > 0 ? n : 0] as const;
      })
  );
}

export function adminStockEntriesForEditor(
  stock: Record<string, number> | undefined
): Array<[string, number]> {
  if (!stock) return [];
  return Object.entries(stock)
    .filter(([itemId]) => !itemId.startsWith('temp_legacy_'))
    .sort(([a], [b]) => a.localeCompare(b));
}
