/**
 * Allowlist for `ui_display_labels` (POST /api/admin/display-labels).
 * Built from current game nav shorts + roleta visibility + legacy page/shop/p2p keys
 * so old admin saves keep working.
 */
export const UI_DISPLAY_LABEL_VALUE_MAX = 200;

/** Short keys aligned with `client/src/shared/constants/gameNavLabels.ts` GAME_NAV_LABEL_KEYS. */
export const GAME_NAV_LABEL_SHORT_KEYS = [
  'servers',
  'profile',
  'management',
  'inventory',
  'hardware_store',
  'black_market',
  'arcade',
  'lucky_store',
  'roleta',
  'wallet',
  'withdrawal_history',
  'ranking',
  'upgrade',
  'transparency',
  'support',
  'partners',
  'partner_games',
  'offerwall',
  'mini_blog',
  'quests'
] as const;

/** Legacy page / shop / p2p keys from `legacy/backend/config/uiDisplayLabelKeys.ts`. */
const LEGACY_PAGE_SHOP_P2P_KEYS = [
  'page.servers',
  'page.inventory',
  'page.oficina',
  'page.hardware_store',
  'page.black_market',
  'page.arcade',
  'page.lucky_store',
  'page.wallet',
  'page.upgrade',
  'page.profile',
  'page.transparency',
  'page.support',
  'page.partners',
  'page.partner_games',
  'shop.page_title',
  'shop.checkout_confirm_title',
  'shop.filter.all',
  'shop.filter.machine',
  'shop.filter.infrastructure',
  'shop.filter.battery',
  'shop.filter.wiring',
  'shop.filter.multiplier',
  'p2p.type.all',
  'p2p.type.machine',
  'p2p.type.infrastructure',
  'p2p.type.battery',
  'p2p.type.wiring',
  'p2p.type.multiplier'
] as const;

export const UI_DISPLAY_LABEL_KEYS = [
  ...GAME_NAV_LABEL_SHORT_KEYS.map((k) => `nav.${k}` as const),
  'nav.roleta_tab_visible',
  ...LEGACY_PAGE_SHOP_P2P_KEYS
] as const;

export type UiDisplayLabelKey = (typeof UI_DISPLAY_LABEL_KEYS)[number];

export const UI_DISPLAY_LABEL_KEY_SET = new Set<string>(UI_DISPLAY_LABEL_KEYS);
