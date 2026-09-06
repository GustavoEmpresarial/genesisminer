/**
 * Identidade canónica do catálogo no AdminEditor (Tarefa 3).
 */
import { describe, expect, it } from 'vitest';
import {
  SHOP_PRODUCT_ID_RE,
  applyAdminCatalogItemSave,
  makeSafeShopProductId,
  normalizeUpgradeCatalogIds
} from '../../../client/src/features/admin/lib/upgradeCatalogIds.js';

const base = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Name ${id}`,
  category: 'gpu',
  type: 'machine',
  baseCost: 1,
  baseProduction: 1,
  description: 'd',
  status: 'normal',
  ...extra
});

describe('upgradeCatalogIds — identidade canónica (Tarefa 3)', () => {
  describe('normalizeUpgradeCatalogIds', () => {
    it('D) ID persistido inválido NÃO é remapeado', () => {
      const persisted = new Set(['weird id with spaces']);
      const { upgrades, fixes } = normalizeUpgradeCatalogIds(
        [{ id: 'weird id with spaces', name: 'Legacy', compatibleRacks: [] }],
        persisted
      );
      expect(upgrades[0].id).toBe('weird id with spaces');
      expect(fixes).toEqual([]);
    });

    it('D) ID persistido válido permanece igual', () => {
      const persisted = new Set(['gpu_v1']);
      const { upgrades, fixes } = normalizeUpgradeCatalogIds([base('gpu_v1')], persisted);
      expect(upgrades[0].id).toBe('gpu_v1');
      expect(fixes).toEqual([]);
    });

    it('E) ID novo inválido é corrigido (CREATE)', () => {
      const persisted = new Set(['gpu_v1']);
      const { upgrades, fixes } = normalizeUpgradeCatalogIds(
        [base('gpu_v1'), base('bad id!', { name: 'Novo' })],
        persisted
      );
      expect(upgrades.find((u) => u.id === 'gpu_v1')).toBeTruthy();
      expect(upgrades.some((u) => u.id === 'bad id!')).toBe(false);
      expect(fixes.length).toBe(1);
      expect(SHOP_PRODUCT_ID_RE.test(fixes[0].to)).toBe(true);
    });

    it('F) temp_legacy_ persistido não é remapeado', () => {
      const id = 'temp_legacy_abc';
      const persisted = new Set([id]);
      const { upgrades, fixes } = normalizeUpgradeCatalogIds([base(id)], persisted);
      expect(upgrades[0].id).toBe(id);
      expect(fixes).toEqual([]);
    });
  });

  describe('applyAdminCatalogItemSave', () => {
    it('B) editar nome/descrição/preço/compat preserva ID', () => {
      const catalog = [
        base('upgrade_x', { compatibleRacks: ['rack_a'] }),
        base('upgrade_y')
      ];
      const { upgrades, lockedId } = applyAdminCatalogItemSave({
        gameUpgrades: catalog,
        editingSourceId: 'upgrade_x',
        itemForm: {
          ...catalog[0],
          name: 'Novo Nome',
          description: 'nova desc',
          baseCost: 99,
          compatibleRacks: ['rack_b'],
          // tentativa de rename pela UI/estado — ignorada
          id: 'upgrade_Y_RENAME'
        }
      });
      expect(lockedId).toBe('upgrade_x');
      const x = upgrades.find((u) => u.id === 'upgrade_x');
      expect(x).toBeTruthy();
      expect(x!.name).toBe('Novo Nome');
      expect(x!.description).toBe('nova desc');
      expect(x!.baseCost).toBe(99);
      expect(x!.compatibleRacks).toEqual(['rack_b']);
      expect(upgrades.some((u) => u.id === 'upgrade_Y_RENAME')).toBe(false);
      expect(upgrades.map((u) => u.id).sort()).toEqual(['upgrade_x', 'upgrade_y']);
    });

    it('C) edição não produz previousId nem segundo id', () => {
      const catalog = [base('upgrade_x')];
      const { upgrades } = applyAdminCatalogItemSave({
        gameUpgrades: catalog,
        editingSourceId: 'upgrade_x',
        itemForm: { ...catalog[0], id: 'other', name: 'X' }
      });
      for (const u of upgrades) {
        expect((u as { previousId?: string }).previousId).toBeUndefined();
      }
      expect(upgrades).toHaveLength(1);
      expect(upgrades[0].id).toBe('upgrade_x');
    });

    it('E) CREATE gera/aceita novo ID sem tocar nos persistidos', () => {
      const catalog = [base('upgrade_x')];
      const { upgrades, isCreate, lockedId } = applyAdminCatalogItemSave({
        gameUpgrades: catalog,
        editingSourceId: null,
        itemForm: base('upgrade_new', { name: 'Novo' })
      });
      expect(isCreate).toBe(true);
      expect(lockedId).toBe('upgrade_new');
      expect(upgrades.map((u) => u.id).sort()).toEqual(['upgrade_x', 'upgrade_new'].sort());
    });

    it('E) CREATE com ID inválido rejeita no apply', () => {
      expect(() =>
        applyAdminCatalogItemSave({
          gameUpgrades: [base('upgrade_x')],
          editingSourceId: null,
          itemForm: base('bad id!', { name: 'Novo' })
        })
      ).toThrow(/ID inválido/);
    });

    it('makeSafeShopProductId gera slug para CREATE', () => {
      expect(makeSafeShopProductId('GPU Max v2!')).toMatch(/^[a-z0-9_.-]+$/);
    });

    it('editar rack comum propaga família aos merge_* (name/baseCost intactos)', () => {
      const mergeId = 'merge_rack_a61_uncommon_aaaaaa';
      const catalog = [
        base('rack_a61', {
          type: 'infrastructure',
          category: 'infrastructure',
          slotsCapacity: 6,
          aiSlotsCapacity: 1,
          rackRoomAffinity: 'asic+standard',
          name: 'Rack A61',
          baseCost: 10,
          description: 'root desc',
          icon: '🧊',
          sellInHardwareMarket: true,
          sellInBlackMarket: true
        }),
        base(mergeId, {
          type: 'infrastructure',
          category: 'infrastructure',
          slotsCapacity: 6,
          aiSlotsCapacity: 1,
          rackRoomAffinity: 'asic+standard',
          name: 'Merge Uncommon',
          rarity: 'uncommon',
          baseCost: 50,
          description: 'merge desc',
          icon: '⭐',
          sellInHardwareMarket: false,
          sellInBlackMarket: false
        })
      ];
      const { upgrades } = applyAdminCatalogItemSave({
        gameUpgrades: catalog,
        editingSourceId: 'rack_a61',
        itemForm: {
          ...catalog[0],
          slotsCapacity: 8,
          rackRoomAffinity: 'asic'
        }
      });
      const root = upgrades.find((u) => u.id === 'rack_a61');
      const merge = upgrades.find((u) => u.id === mergeId);
      expect(root?.slotsCapacity).toBe(8);
      expect(root?.rackRoomAffinity).toBe('asic');
      expect(merge?.slotsCapacity).toBe(8);
      expect(merge?.rackRoomAffinity).toBe('asic');
      expect(merge?.name).toBe('Merge Uncommon');
      expect(merge?.baseCost).toBe(50);
      expect(merge?.description).toBe('merge desc');
      expect(merge?.icon).toBe('⭐');
      expect(merge?.rarity).toBe('uncommon');
      expect(merge?.sellInHardwareMarket).toBe(false);
      expect(merge?.sellInBlackMarket).toBe(false);
    });
  });
});
