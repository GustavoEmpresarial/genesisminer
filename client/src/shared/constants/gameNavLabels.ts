/** Max length for admin-editable UI display label values (aligned with server). */
export const UI_DISPLAY_LABEL_VALUE_MAX = 200;

/** Page IDs shown in the in-game navigation bar (menu order). */
export const GAME_NAV_LABEL_KEYS = [
  'servers',
  'checkin',
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

export type GameNavLabelKey = (typeof GAME_NAV_LABEL_KEYS)[number];

/** Default labels when the server has no `game_nav_labels` yet. Player UI = English. */
export const DEFAULT_GAME_NAV_LABELS: Record<GameNavLabelKey, string> = {
  servers: 'Mining',
  checkin: 'Check-in',
  profile: 'Profile',
  management: 'Management',
  inventory: 'Inventory',
  hardware_store: 'Miner Shop',
  black_market: 'P2P Market',
  arcade: 'Arcade',
  lucky_store: 'Loot Box',
  roleta: 'Wheel',
  wallet: 'My Wallet',
  withdrawal_history: 'Withdrawal History',
  ranking: 'Leaderboard',
  upgrade: 'Events & Passes',
  transparency: 'Transparency Portal',
  support: 'Support',
  partners: 'Streamer Partnership',
  partner_games: 'Partner · Games',
  offerwall: 'Offerwall',
  mini_blog: 'Mini Blog',
  quests: 'Quests'
};

/** Fallback allowed pages when a level has no explicit `allowedPages`. */
export const DEFAULT_ALLOWED_PAGES = [
  'servers',
  'checkin',
  'inventory',
  'merge',
  'arcade',
  'ranking',
  'hardware_store',
  'black_market',
  'lucky_store',
  'wallet',
  'withdrawal_history',
  'deposit_history',
  'upgrade',
  'profile',
  'transparency',
  'support',
  'partners',
  'partner_games',
  'mini_blog',
  'quests',
  'offerwall'
] as const;
