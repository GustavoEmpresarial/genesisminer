/**
 * Detecta nomes duplicados no catálogo admin (hardware).
 *
 * IDs `merge_*` partilham intencionalmente o display «Merged {base}» —
 * não contam como duplicados entre si nem face ao catálogo base.
 * Só itens não-merge com o mesmo nome normalizado são marcados.
 */

const MERGE_ID_PREFIX = 'merge_';

export type CatalogNameRow = {
  id: string;
  name?: string | null;
};

export function isMergeCatalogId(id: string): boolean {
  return id.startsWith(MERGE_ID_PREFIX);
}

/** Normaliza nome para comparação de duplicados. */
export function normalizeCatalogDisplayName(name: string | null | undefined): string {
  return String(name || '')
    .trim()
    .toLowerCase();
}

/**
 * IDs de itens **não-merge** cujo nome normalizado aparece mais de uma vez
 * entre outros itens não-merge.
 */
export function collectDuplicateNonMergeNameIds(rows: ReadonlyArray<CatalogNameRow>): Set<string> {
  const byName = new Map<string, string[]>();
  for (const u of rows) {
    const id = String(u.id || '');
    if (!id || isMergeCatalogId(id)) continue;
    const key = normalizeCatalogDisplayName(u.name);
    if (!key) continue;
    const list = byName.get(key) || [];
    list.push(id);
    byName.set(key, list);
  }
  const dup = new Set<string>();
  for (const ids of byName.values()) {
    if (ids.length > 1) {
      for (const id of ids) dup.add(id);
    }
  }
  return dup;
}
