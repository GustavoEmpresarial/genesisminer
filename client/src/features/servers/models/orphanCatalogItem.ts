import type { Upgrade } from '../types';

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Placeholder de UI quando o id já não existe em `upgrades` (peça retirada do catálogo).
 * Mantém o `id` original **só** para desmontar / gravar estado — nunca mostrar ao jogador.
 * Apagar catálogo/código NÃO deve apagar o item da conta: vira legacy (igual caixas/pacotes).
 * Pass `t` when available so name/description follow the active locale.
 */
export function orphanCatalogUpgrade(
  id: string,
  type: Upgrade['type'],
  t?: TranslateFn
): Upgrade {
  const typeLabel = t ? t(catalogTypeLabelKey(type)) : catalogTypeLabel(type);
  const name = t
    ? t('servers.room.orphanName', { type: typeLabel })
    : `${typeLabel} (removed from catalog)`;
  const description = t
    ? t('servers.room.orphanDescription')
    : 'This item is no longer in the active catalog. You can remove or replace it; equipment already owned stays as a legacy piece.';
  return {
    id,
    name,
    category: 'legacy',
    type,
    baseCost: 0,
    baseProduction: 0,
    powerConsumption: 0,
    powerCapacity: type === 'battery' ? 100 : undefined,
    multiplier: type === 'multiplier' ? 0 : undefined,
    description,
    icon: '📦',
    status: 'legacy'
  };
}

/** Label de tipo para UI — sem expor o id interno. */
export function catalogTypeLabel(type: Upgrade['type'] | string | undefined): string {
  switch (type) {
    case 'machine':
      return 'Machine';
    case 'battery':
      return 'Battery';
    case 'wiring':
      return 'Wiring';
    case 'multiplier':
      return 'Multiplier';
    case 'infrastructure':
      return 'Rack / infra';
    default:
      return 'Part';
  }
}

/** i18n key for catalog type label (`servers.room.type*`). */
export function catalogTypeLabelKey(type: Upgrade['type'] | string | undefined): string {
  switch (type) {
    case 'machine':
      return 'servers.room.typeMachine';
    case 'battery':
      return 'servers.room.typeBattery';
    case 'wiring':
      return 'servers.room.typeWiring';
    case 'multiplier':
      return 'servers.room.typeMultiplier';
    case 'infrastructure':
      return 'servers.room.typeInfrastructure';
    default:
      return 'servers.room.typePart';
  }
}
