/**
 * Árvore do catálogo admin: roots comuns + merges nested.
 * Ordem de raridade = select «Raridade (Merge)» do AdminEditor.
 */
import type { UpgradeRarity } from './adminTypes';
import { isMergeCatalogId } from './upgradeCatalogDuplicateNames';
import { mergeCatalogRootId } from '../../servers/lib/upgradeRackCompat';

/** Mesma ordem do `<select>` Raridade (Merge) no AdminEditor. */
export const UPGRADE_RARITY_ORDER: readonly UpgradeRarity[] = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
  'supreme'
] as const;

export type CatalogRarityFilter = 'all' | UpgradeRarity;

export type CatalogTreeItem = {
  id: string;
  name?: string | null;
  rarity?: string | null;
  category?: string | null;
  type?: string;
};

export type CatalogTreeNode<T extends CatalogTreeItem = CatalogTreeItem> = {
  item: T;
  children: T[];
};

const RARITY_SET = new Set<string>(UPGRADE_RARITY_ORDER);

/** Parse order: longer tokens first so `uncommon` wins over `common`. */
const RARITY_PARSE_ORDER: readonly UpgradeRarity[] = [...UPGRADE_RARITY_ORDER].sort(
  (a, b) => b.length - a.length
);

function rarityFromMergeId(id: string): UpgradeRarity | null {
  if (!isMergeCatalogId(id)) return null;
  const body = id.slice('merge_'.length).toLowerCase();
  for (const rarity of RARITY_PARSE_ORDER) {
    const needle = `_${rarity}_`;
    const idx = body.lastIndexOf(needle);
    if (idx < 0) continue;
    const hash = body.slice(idx + needle.length);
    if (!/^[a-f0-9]{6,16}$/i.test(hash)) continue;
    const source = body.slice(0, idx);
    if (source) return rarity;
  }
  return null;
}

function isUpgradeRarity(value: string | null | undefined): value is UpgradeRarity {
  return !!value && RARITY_SET.has(value);
}

export function catalogItemRarity(item: CatalogTreeItem): UpgradeRarity {
  const raw = String(item.rarity ?? '')
    .trim()
    .toLowerCase();
  if (isUpgradeRarity(raw)) return raw;
  const fromId = rarityFromMergeId(String(item.id || ''));
  return fromId ?? 'common';
}

function raritySortIndex(rarity: UpgradeRarity): number {
  const idx = UPGRADE_RARITY_ORDER.indexOf(rarity);
  return idx < 0 ? UPGRADE_RARITY_ORDER.length : idx;
}

function compareByRarityThenName(a: CatalogTreeItem, b: CatalogTreeItem): number {
  const byRarity = raritySortIndex(catalogItemRarity(a)) - raritySortIndex(catalogItemRarity(b));
  if (byRarity !== 0) return byRarity;
  return String(a.name || a.id || '').localeCompare(String(b.name || b.id || ''), 'en', {
    sensitivity: 'base'
  });
}

function itemMatchesSearch(item: CatalogTreeItem, q: string): boolean {
  if (!q) return true;
  return (
    String(item.id || '')
      .toLowerCase()
      .includes(q) ||
    String(item.name || '')
      .toLowerCase()
      .includes(q) ||
    String(item.category || '')
      .toLowerCase()
      .includes(q)
  );
}

export function buildCatalogTree<T extends CatalogTreeItem>(items: ReadonlyArray<T>): CatalogTreeNode<T>[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const id = String(item.id || '');
    if (!id) continue;
    byId.set(id, item);
  }

  const childrenByRoot = new Map<string, T[]>();
  const orphanMerges: T[] = [];
  const roots: T[] = [];

  for (const item of items) {
    const id = String(item.id || '');
    if (!id) continue;
    if (!isMergeCatalogId(id)) {
      roots.push(item);
      continue;
    }
    const rootId = mergeCatalogRootId(id);
    if (rootId && rootId !== id && byId.has(rootId)) {
      const list = childrenByRoot.get(rootId) || [];
      list.push(item);
      childrenByRoot.set(rootId, list);
    } else {
      orphanMerges.push(item);
    }
  }

  const nodes: CatalogTreeNode<T>[] = roots.map((item) => {
    const children = [...(childrenByRoot.get(String(item.id)) || [])].sort(compareByRarityThenName);
    return { item, children };
  });

  for (const orphan of orphanMerges) {
    nodes.push({ item: orphan, children: [] });
  }

  return nodes;
}

export function filterCatalogTree<T extends CatalogTreeItem>(
  nodes: ReadonlyArray<CatalogTreeNode<T>>,
  opts: { search: string; rarity: CatalogRarityFilter }
): CatalogTreeNode<T>[] {
  const q = String(opts.search || '')
    .trim()
    .toLowerCase();
  const rarity = opts.rarity;

  const out: CatalogTreeNode<T>[] = [];

  for (const node of nodes) {
    const rootMatchesSearch = itemMatchesSearch(node.item, q);
    let children = node.children;
    if (q) {
      if (rootMatchesSearch) {
        // keep all children (further rarity filter below)
      } else {
        children = children.filter((c) => itemMatchesSearch(c, q));
        if (children.length === 0) continue;
      }
    }

    if (rarity === 'all') {
      out.push({ item: node.item, children: [...children] });
      continue;
    }

    if (rarity === 'common') {
      if (catalogItemRarity(node.item) !== 'common') continue;
      // Keep nested merges visible under the common root (do not promote).
      out.push({ item: node.item, children: [...children] });
      continue;
    }

    const rootHasRarity = catalogItemRarity(node.item) === rarity;
    const matchingChildren = children.filter((c) => catalogItemRarity(c) === rarity);
    if (!rootHasRarity && matchingChildren.length === 0) continue;
    out.push({
      item: node.item,
      children: matchingChildren
    });
  }

  return out;
}
