import type { Upgrade } from '../../servers/types';
import { mergeCatalogRootId } from '../../servers/lib/upgradeRackCompat';
import { formatHashrateDisplay } from '../../servers/models/serverRoomModel';

export type UpgradeMarketSpec = {
  label: string;
  value: string;
  tone?: 'green' | 'orange' | 'sky' | 'yellow' | 'slate';
};

/** Quantos nomes de rack mostrar no card P2P (resto vira `… +N`). */
const COMPAT_NAMES_CARD_MAX = 4;

function catalogNameForId(catalog: Upgrade[], id: string): string | null {
  const direct = catalog.find((u) => u.id === id);
  if (direct?.name?.trim()) return direct.name.trim();
  const root = mergeCatalogRootId(id);
  if (root && root !== id) {
    const byRoot = catalog.find((u) => u.id === root);
    if (byRoot?.name?.trim()) return byRoot.name.trim();
    const anyLineage = catalog.find((u) => mergeCatalogRootId(u.id) === root && u.name?.trim());
    if (anyLineage?.name?.trim()) return anyLineage.name.trim();
  }
  return null;
}

/**
 * Lista curta e legível de racks compatíveis:
 * - dedupe por linhagem merge (vários `merge_*` → um nome)
 * - não despeja IDs `merge_*` crus
 * - limita a N nomes + `… +resto`
 */
export function resolveCompatibleRackNames(item: Upgrade, catalog: Upgrade[]): string {
  if (!Array.isArray(item.compatibleRacks) || item.compatibleRacks.length === 0) {
    return 'Qualquer rack';
  }

  const seenRoots = new Set<string>();
  const names: string[] = [];

  for (const raw of item.compatibleRacks) {
    const id = String(raw ?? '').trim();
    if (!id) continue;
    const root = mergeCatalogRootId(id) || id;
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);

    const name = catalogNameForId(catalog, id);
    if (name) {
      // Nome no catálogo às vezes é o próprio id merge_* — não despejar.
      if (/^merge_/i.test(name) || /^merge_/i.test(id)) {
        const rootName = catalogNameForId(catalog, root);
        if (rootName && !/^merge_/i.test(rootName)) {
          names.push(rootName);
          continue;
        }
        continue;
      }
      names.push(name);
      continue;
    }
    // Sem nome no catálogo: ignora merges truncados/lixo; IDs base ficam só se forem poucos.
    if (id.startsWith('merge_')) continue;
    names.push(id);
  }

  if (names.length === 0) return 'Vários racks';
  if (names.length <= COMPAT_NAMES_CARD_MAX) return names.join(', ');
  const shown = names.slice(0, COMPAT_NAMES_CARD_MAX);
  return `${shown.join(', ')}… +${names.length - COMPAT_NAMES_CARD_MAX}`;
}

/** Linhas curtas de spec para comparar valor vs desempenho no Mercado Negro / P2P. */
export function getUpgradeMarketSpecs(item: Upgrade, catalog: Upgrade[] = []): UpgradeMarketSpec[] {
  const specs: UpgradeMarketSpec[] = [];
  const t = item.type;

  if (t === 'machine') {
    const bp = Number(item.baseProduction) || 0;
    if (bp > 0) {
      specs.push({ label: 'Hashrate', value: `+${formatHashrateDisplay(bp)} H/s`, tone: 'green' });
    }
    if (typeof item.powerConsumption === 'number' && item.powerConsumption > 0) {
      specs.push({ label: 'Consumo', value: `${item.powerConsumption} W`, tone: 'slate' });
    }
    specs.push({ label: 'Compatível', value: resolveCompatibleRackNames(item, catalog), tone: 'slate' });
  } else if (t === 'multiplier') {
    const pct = (Number(item.multiplier) || 0) * 100;
    if (pct > 0) {
      specs.push({ label: 'Boost', value: `+${pct.toFixed(1)}%`, tone: 'orange' });
    }
    specs.push({ label: 'Compatível', value: resolveCompatibleRackNames(item, catalog), tone: 'slate' });
  } else if (t === 'wiring') {
    specs.push({ label: 'Encaixa em', value: resolveCompatibleRackNames(item, catalog), tone: 'sky' });
    if (typeof item.powerConsumption === 'number' && item.powerConsumption > 0) {
      specs.push({ label: 'Consumo', value: `${item.powerConsumption} W`, tone: 'slate' });
    }
  } else if (t === 'infrastructure') {
    const slots = Number(item.slotsCapacity) || 0;
    const ai = Number(item.aiSlotsCapacity) || 0;
    const parts: string[] = ['Rack / gabinete'];
    if (slots > 0) parts.push(`${slots} slot${slots === 1 ? '' : 's'} GPU`);
    if (ai > 0) parts.push(`${ai} chip${ai === 1 ? '' : 's'} IA`);
    specs.push({ label: 'Tipo', value: parts.join(' · '), tone: 'sky' });
  } else if (t === 'battery') {
    const cap = item.powerCapacity;
    specs.push({
      label: 'Capacidade',
      value: cap === -1 ? '∞ Wh' : `${Number(cap || 0).toLocaleString('pt-PT')} Wh`,
      tone: 'yellow'
    });
    specs.push({ label: 'Compatível', value: resolveCompatibleRackNames(item, catalog), tone: 'slate' });
  }

  return specs;
}

export function getUpgradeMarketSpecSummary(item: Upgrade, catalog: Upgrade[] = []): string {
  return getUpgradeMarketSpecs(item, catalog)
    .map((s) => s.value)
    .join(' · ');
}
