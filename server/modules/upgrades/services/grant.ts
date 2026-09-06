/**
 * Migrado de legacy/backend/models/adminUpgradeGrantModel.ts (verbatim,
 * arquivo completo agora — `grantPassRewardsInTx`, `grantAdminUpgradeRewardsInTx`
 * e `expandAdminUpgradeBundleAsLootRewardsInTx` foram adicionados quando
 * `modules/lucky-boxes` migrou e passou a precisar do fluxo real de
 * *abertura* de caixa/season-pass, que `materializeUpgradePackageAsLootBoxInTx`
 * sozinha não cobre).
 *
 * Compra de pacote (`modules/upgrades`): o pacote é materializado como **uma
 * caixa única** em `loot_boxes` (`is_active=0`, não aparece na loja) e
 * incrementa `unopened_boxes` em +1 — entrega real só ao abrir a caixa.
 *
 * Abertura de caixa (`modules/lucky-boxes`): `grantAdminUpgradeRewardsInTx`
 * entrega de facto USDC/moedas/items/caixas/passes/access_level (a linha
 * interna `item_type='bundle'` de uma caixa materializada delega nela);
 * `expandAdminUpgradeBundleAsLootRewardsInTx` só lê o conteúdo nominal do
 * pacote (sem escrever na BD) pra substituir essa linha `bundle` crua pelos
 * prémios reais na resposta ao jogador.
 */
import type { Prisma } from '@prisma/client';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import { creditCatalogItemQtyInTx } from '../../hardware/services/credit-catalog.js';

const HTTP_CONFLICT = 409;

export const UPGRADE_PACKAGE_BOX_TRIGGER = 'upgrade_package';
const BOX_ID_MAX_LENGTH = 200;
const BOX_NAME_MAX_LENGTH = 200;
const BOX_ICON = '📦';
/** Sempre 1: cada pacote comprado materializa exactamente 1 caixa nova por compra. */
const GRANT_QTY = 1;

/** Aceita apenas chars suportados por `parseLootBoxId` (`[a-zA-Z0-9_.-]+`). */
function upgradePackageBoxIdFromUpgradeId(upgradeId: string): string {
  const safe = String(upgradeId || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `upgrade_pkg_${safe}`.slice(0, BOX_ID_MAX_LENGTH);
}

type LootBoxItemDraft = {
  item_type: string;
  item_id: string;
  min_qty: number;
  max_qty: number;
  probability: number;
};

const BUNDLE_DRAFT_PROBABILITY = 100;
const FIXED_REWARD_PROBABILITY = 0;

/**
 * Materializa um pacote de upgrade como **uma única caixa** em `loot_boxes` e
 * credita +1 unidade em `unopened_boxes` pro utilizador. Deve correr dentro
 * da mesma transação que debita o USDC da compra.
 */
export async function materializeUpgradePackageAsLootBoxInTx(tx: Prisma.TransactionClient, args: { userId: number; upgradeId: string }): Promise<{ boxId: string; boxName: string }> {
  const { userId, upgradeId } = args;
  const upgrade = await tx.admin_upgrades.findUnique({ where: { id: upgradeId } });
  if (!upgrade) {
    // Invariante violado: o pacote existia quando a compra foi validada, mas sumiu até
    // aqui (mesma transação) — conflito de concorrência, não erro de input do jogador.
    throw new HttpControlledError(HTTP_CONFLICT, { error: 'Upgrade not found when materializing box.', code: 'UPGRADE_NOT_FOUND' });
  }

  const boxId = upgradePackageBoxIdFromUpgradeId(upgrade.id);
  const baseName = String(upgrade.name || '').trim();
  const boxName = (baseName ? `Pacote ${baseName}` : `Pacote ${upgrade.id}`).slice(0, BOX_NAME_MAX_LENGTH);
  const description = `Pacote de upgrade · abra para receber o conteúdo. (upgrade_package:${upgrade.id})`;

  await tx.loot_boxes.upsert({
    where: { id: boxId },
    create: {
      id: boxId,
      name: boxName,
      description,
      price: 0,
      trigger: UPGRADE_PACKAGE_BOX_TRIGGER,
      icon: BOX_ICON,
      // is_active=0: não aparece na loja (shop/shop_once/special); inventário ignora este filtro.
      is_active: 0,
      stock: null,
      max_per_order: 1,
      max_per_user: null
    },
    update: {
      name: boxName,
      description,
      trigger: UPGRADE_PACKAGE_BOX_TRIGGER,
      icon: BOX_ICON,
      is_active: 0
    }
  });

  const [adminItems, adminCoins] = await Promise.all([
    tx.admin_upgrade_items.findMany({ where: { upgrade_id: upgrade.id } }),
    tx.admin_upgrade_coins.findMany({ where: { upgrade_id: upgrade.id } })
  ]);

  const drafts: LootBoxItemDraft[] = [
    { item_type: 'bundle', item_id: upgrade.id, min_qty: 1, max_qty: 1, probability: BUNDLE_DRAFT_PROBABILITY }
  ];

  for (const it of adminItems) {
    const q = Math.max(0, Math.floor(Number(it.qty) || 0));
    if (q <= 0) continue;
    drafts.push({ item_type: 'item', item_id: String(it.item_id), min_qty: q, max_qty: q, probability: FIXED_REWARD_PROBABILITY });
  }

  const usdc = Math.max(0, Number(upgrade.grant_usdc ?? 0));
  if (Number.isFinite(usdc) && usdc > 0) {
    drafts.push({ item_type: 'currency', item_id: 'usdc', min_qty: Math.floor(usdc), max_qty: Math.floor(usdc), probability: FIXED_REWARD_PROBABILITY });
  }

  for (const c of adminCoins) {
    const amt = Math.max(0, Math.floor(Number(c.amount) || 0));
    if (amt <= 0) continue;
    drafts.push({ item_type: 'coin', item_id: String(c.coin_id), min_qty: amt, max_qty: amt, probability: FIXED_REWARD_PROBABILITY });
  }

  // Caixas-recompensa incluídas pelo pacote (admin_upgrade_boxes) e season-passes
  // (admin_upgrade_passes) ficam fora do display, entregues no `open` do
  // lucky-box — não migrado ainda; ver header do arquivo.

  await tx.loot_box_items.deleteMany({ where: { box_id: boxId } });
  if (drafts.length > 0) {
    await tx.loot_box_items.createMany({
      data: drafts.map((d) => ({ box_id: boxId, item_type: d.item_type, item_id: d.item_id, min_qty: d.min_qty, max_qty: d.max_qty, probability: d.probability }))
    });
  }

  await tx.unopened_boxes.upsert({
    where: { user_id_box_id: { user_id: userId, box_id: boxId } },
    create: { user_id: userId, box_id: boxId, qty: GRANT_QTY },
    update: { qty: { increment: GRANT_QTY } }
  });

  return { boxId, boxName };
}

/** ID do pacote-bundle inicial (Genesis) que também concede a sala inicial gratuita. */
const GENESIS_BUNDLE_UPGRADE_ID = '53f0c699-0471-4e65-a147-17064e3aafe0';
const GENESIS_ROOM_ID = 'room_1765936323521';
const GENESIS_ROOM_UNLOCKED_SLOTS = 0;

/**
 * Recompensas de season pass (ordem USDC → moedas → stock → caixas legacy).
 * Deve correr dentro do mesmo `prisma.$transaction` que o resgate/compra.
 */
export async function grantPassRewardsInTx(tx: Prisma.TransactionClient, userId: number, passId: string, seasonId: string): Promise<void> {
  const CURRENCY_TYPE = 'currency';
  const USDC_COIN_ID = 'usdc';
  const rewards = await tx.season_pass_rewards.findMany({ where: { pass_id: passId } });

  const usdcRewards = rewards.filter((r) => r.type === CURRENCY_TYPE && r.coin_id === USDC_COIN_ID);
  const coinRewards = rewards.filter((r) => r.type === CURRENCY_TYPE && r.coin_id && r.coin_id !== USDC_COIN_ID);
  const itemRewards = rewards.filter((r) => r.type === 'item');

  for (const reward of usdcRewards) {
    const q = Number(reward.qty);
    if (!Number.isFinite(q) || q === 0) continue;
    await tx.game_states.updateMany({ where: { user_id: userId }, data: { usdc: { increment: q } } });
  }

  for (const reward of coinRewards) {
    const cid = String(reward.coin_id || '');
    const q = Number(reward.qty);
    if (!cid || !Number.isFinite(q) || q === 0) continue;
    await tx.coin_balances.upsert({
      where: { user_id_coin_id: { user_id: userId, coin_id: cid } },
      create: { user_id: userId, coin_id: cid, amount: q },
      update: { amount: { increment: q } }
    });
  }

  for (const reward of itemRewards) {
    const iid = String(reward.item_id || '');
    const q = Math.floor(Number(reward.qty));
    if (!iid || !Number.isFinite(q) || q <= 0) continue;
    await creditCatalogItemQtyInTx(tx, userId, iid, q);
  }

  const passT = passId.trim();
  const seasonT = `season:${seasonId.trim()}`;
  const boxRewards = await tx.loot_boxes.findMany({
    where: { OR: [{ trigger: { equals: passT, mode: 'insensitive' } }, { trigger: { equals: seasonT, mode: 'insensitive' } }] },
    select: { id: true }
  });

  for (const box of boxRewards) {
    await tx.unopened_boxes.upsert({
      where: { user_id_box_id: { user_id: userId, box_id: box.id } },
      create: { user_id: userId, box_id: box.id, qty: 1 },
      update: { qty: { increment: 1 } }
    });
  }
}

/** Item entregue por um bundle expandido (formato compatível com `LootRewardGrant` de `modules/lucky-boxes`). */
export type AdminUpgradeBundleReward = {
  type: 'item' | 'currency' | 'coin' | 'box' | 'pass' | 'access_level';
  id: string;
  qty: number;
};

/**
 * Lê o conteúdo nominal de um pacote admin (`admin_upgrade_*`) e devolve uma lista de
 * recompensas em formato compatível com `LootRewardGrant`. Usado pela abertura de caixa
 * (`modules/lucky-boxes`) pra substituir a entrada interna `type='bundle'` (que não tem
 * nome próprio no catálogo do utilizador) pelos prémios reais exibidos ao jogador. Não
 * faz writes na BD.
 *
 * `multiplier` suporta bundles abertos N vezes (a caixa pode ter `max_qty` > 1).
 */
export async function expandAdminUpgradeBundleAsLootRewardsInTx(
  tx: Prisma.TransactionClient,
  upgradeId: string,
  multiplier: number
): Promise<AdminUpgradeBundleReward[]> {
  const m = Math.max(0, Math.floor(Number(multiplier) || 0));
  if (!m) return [];

  const upgrade = await tx.admin_upgrades.findUnique({ where: { id: upgradeId }, select: { grant_usdc: true, grant_access_level_id: true } });
  if (!upgrade) return [];

  const [items, coins, boxes, passes] = await Promise.all([
    tx.admin_upgrade_items.findMany({ where: { upgrade_id: upgradeId } }),
    tx.admin_upgrade_coins.findMany({ where: { upgrade_id: upgradeId } }),
    tx.admin_upgrade_boxes.findMany({ where: { upgrade_id: upgradeId } }),
    tx.admin_upgrade_passes.findMany({ where: { upgrade_id: upgradeId } })
  ]);

  const out: AdminUpgradeBundleReward[] = [];

  const usdc = Number(upgrade.grant_usdc ?? 0);
  if (Number.isFinite(usdc) && usdc > 0) {
    out.push({ type: 'currency', id: 'usdc', qty: usdc * m });
  }

  for (const it of items) {
    const q = Math.floor(Number(it.qty));
    if (!Number.isFinite(q) || q <= 0) continue;
    out.push({ type: 'item', id: String(it.item_id), qty: q * m });
  }

  for (const c of coins) {
    const q = Number(c.amount);
    if (!Number.isFinite(q) || q === 0) continue;
    out.push({ type: 'coin', id: String(c.coin_id), qty: q * m });
  }

  for (const b of boxes) {
    const q = Math.floor(Number(b.qty));
    if (!Number.isFinite(q) || q <= 0) continue;
    out.push({ type: 'box', id: String(b.box_id), qty: q * m });
  }

  /** Passes/acesso são marcadores de display (qty=1 cada); a entrega real fica em `grantAdminUpgradeRewardsInTx`. */
  for (const p of passes) {
    const passId = String(p.pass_id || '').trim();
    if (!passId) continue;
    out.push({ type: 'pass', id: passId, qty: m });
  }

  const alid = String(upgrade.grant_access_level_id ?? '').trim();
  if (alid) {
    out.push({ type: 'access_level', id: alid, qty: 1 });
  }

  return out;
}

/**
 * Concede um pacote admin (loja/promo/bundle de caixa) dentro de uma transação Prisma:
 * USDC, moedas, items, caixas-recompensa, season passes (+ recompensas do pass) e
 * access level. Efeitos colaterais reais na BD — usada na abertura de caixa
 * (`modules/lucky-boxes`), não na compra (que só materializa a caixa).
 */
export async function grantAdminUpgradeRewardsInTx(userId: number, upgradeId: string, tx: Prisma.TransactionClient): Promise<Record<string, unknown>> {
  const upgrade = await tx.admin_upgrades.findUnique({ where: { id: upgradeId } });
  if (!upgrade) {
    // Mesma situação de `materializeUpgradePackageAsLootBoxInTx`: conflito de
    // concorrência (pacote sumiu entre a caixa ser sorteada e ser aberta), não input inválido.
    throw new HttpControlledError(HTTP_CONFLICT, { error: 'Upgrade not found.', code: 'UPGRADE_NOT_FOUND' });
  }

  const grantUsdc = Number(upgrade.grant_usdc ?? 0);
  if (Number.isFinite(grantUsdc) && grantUsdc > 0) {
    await tx.game_states.updateMany({ where: { user_id: userId }, data: { usdc: { increment: grantUsdc } } });
  }

  const coins = await tx.admin_upgrade_coins.findMany({ where: { upgrade_id: upgrade.id } });
  for (const c of coins) {
    const amt = Number(c.amount);
    if (!Number.isFinite(amt) || amt === 0) continue;
    await tx.coin_balances.upsert({
      where: { user_id_coin_id: { user_id: userId, coin_id: c.coin_id } },
      create: { user_id: userId, coin_id: c.coin_id, amount: amt },
      update: { amount: { increment: amt } }
    });
  }

  const items = await tx.admin_upgrade_items.findMany({ where: { upgrade_id: upgrade.id } });
  for (const it of items) {
    const q = Math.floor(Number(it.qty));
    if (!Number.isFinite(q) || q <= 0) continue;
    await creditCatalogItemQtyInTx(tx, userId, String(it.item_id), q);
  }

  const boxes = await tx.admin_upgrade_boxes.findMany({ where: { upgrade_id: upgrade.id } });
  for (const b of boxes) {
    const q = Math.floor(Number(b.qty));
    if (!Number.isFinite(q) || q <= 0) continue;
    await tx.unopened_boxes.upsert({
      where: { user_id_box_id: { user_id: userId, box_id: b.box_id } },
      create: { user_id: userId, box_id: b.box_id, qty: q },
      update: { qty: { increment: q } }
    });
  }

  const passes = await tx.admin_upgrade_passes.findMany({ where: { upgrade_id: upgrade.id } });
  const now = BigInt(Date.now());
  for (const p of passes) {
    const sp = await tx.season_passes.findUnique({ where: { id: p.pass_id }, select: { season_id: true } });
    if (!sp?.season_id) continue;
    const seasonId = String(sp.season_id);
    await tx.season_purchases.createMany({ data: [{ user_id: userId, pass_id: p.pass_id, season_id: seasonId, purchased_at: now }], skipDuplicates: true });
    await grantPassRewardsInTx(tx, userId, p.pass_id, seasonId);
  }

  const al = upgrade.grant_access_level_id;
  if (al != null && String(al).trim() !== '') {
    const alid = String(al).trim();
    await tx.users.update({ where: { id: userId }, data: { access_level_id: alid } });
    await tx.user_access_levels.createMany({ data: [{ user_id: userId, access_level_id: alid, granted_at: now }], skipDuplicates: true });
  }

  const boxRewards = await tx.loot_boxes.findMany({ where: { trigger: upgradeId }, select: { id: true } });
  for (const box of boxRewards) {
    await tx.unopened_boxes.upsert({
      where: { user_id_box_id: { user_id: userId, box_id: box.id } },
      create: { user_id: userId, box_id: box.id, qty: 1 },
      update: { qty: { increment: 1 } }
    });
  }

  if (upgradeId === GENESIS_BUNDLE_UPGRADE_ID) {
    // `user_rig_rooms.room_id` não tem FK para `rig_rooms` — se o ID mudar de ambiente
    // (seed diferente), o insert abaixo "funciona" silenciosamente e cria um registo
    // órfão que nunca aparece no catálogo do jogador. Checar e logar bem alto em vez
    // de falhar a concessão inteira por causa disto (USDC/moedas/items já foram
    // creditados acima e não devem ser revertidos por este efeito colateral extra).
    const genesisRoomExists = await tx.rig_rooms.findUnique({ where: { id: GENESIS_ROOM_ID }, select: { id: true } });
    if (!genesisRoomExists) {
      console.error(
        JSON.stringify({ event: 'genesis_bundle_room_missing', upgradeId, roomId: GENESIS_ROOM_ID, userId, message: 'GENESIS_ROOM_ID aponta para uma sala inexistente nesta base — confirmar seed.' })
      );
    }
    await tx.user_rig_rooms.createMany({
      data: [{ user_id: userId, room_id: GENESIS_ROOM_ID, purchased_at: now, unlocked_slots: GENESIS_ROOM_UNLOCKED_SLOTS }],
      skipDuplicates: true
    });
  }

  return upgrade as unknown as Record<string, unknown>;
}
