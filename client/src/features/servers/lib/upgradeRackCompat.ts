/**
 * Compatibilidade de GPU / bateria / fiação com rigs:
 * se o item lista a rig base, vale também para qualquer resultado de merge
 * dessa mesma linhagem (e vice-versa), independente da raridade.
 */

const MERGE_RESULT_RARITIES = [
  'supreme',
  'legendary',
  'uncommon',
  'common',
  'epic',
  'rare'
] as const;

/** Remove uma camada `merge_<source>_<rarity>_<hash>`. */
export function peelMergeCatalogLayer(itemId: string): string | null {
  const id = String(itemId || '').trim();
  if (!id.startsWith('merge_')) return null;
  const body = id.slice('merge_'.length);
  for (const rarity of MERGE_RESULT_RARITIES) {
    const needle = `_${rarity}_`;
    const idx = body.toLowerCase().lastIndexOf(needle);
    if (idx < 0) continue;
    const hash = body.slice(idx + needle.length);
    if (!/^[a-f0-9]{6,16}$/i.test(hash)) continue;
    const source = body.slice(0, idx);
    if (source) return source;
  }
  return null;
}

/** Raiz de catálogo (ex.: merge_rack04_cores_uncommon_abc → rack04_cores). */
export function mergeCatalogRootId(itemId: string): string {
  let id = String(itemId || '').trim();
  if (!id) return id;
  let guard = 0;
  while (id.startsWith('merge_') && guard++ < 24) {
    const next = peelMergeCatalogLayer(id);
    if (!next || next === id) break;
    id = next;
  }
  return id;
}

export function normalizeCompatibleRackIdsToRoots(ids: string[] | null | undefined): string[] {
  if (!ids?.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const root = mergeCatalogRootId(String(raw || '').trim());
    if (!root || seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

/**
 * `compatibleRacks` vazio = encaixa em todas.
 * Caso contrário, compara IDs exactos e linhagem merge↔base.
 */
export function isCompatibleWithRack(
  compatibleRacks: string[] | null | undefined,
  rackItemId: string
): boolean {
  if (!compatibleRacks?.length) return true;
  const rackId = String(rackItemId || '').trim();
  if (!rackId) return false;
  if (compatibleRacks.includes(rackId)) return true;

  const rackRoot = mergeCatalogRootId(rackId);
  for (const raw of compatibleRacks) {
    const listed = String(raw || '').trim();
    if (!listed) continue;
    if (listed === rackId) return true;
    const listedRoot = mergeCatalogRootId(listed);
    if (listedRoot && rackRoot && listedRoot === rackRoot) return true;
    // IDs truncados pelo limite de 120 chars ainda embutem o root base.
    // Usar `_base_` (com underscores) evita prefixos (rack_a61 vs rack_a610).
    if (!listed.startsWith('merge_') && rackId.startsWith('merge_')) {
      if (rackId.includes(`_${listed}_`)) return true;
    }
    if (!rackId.startsWith('merge_') && listed.startsWith('merge_')) {
      if (listed.includes(`_${rackId}_`)) return true;
    }
  }
  return false;
}
