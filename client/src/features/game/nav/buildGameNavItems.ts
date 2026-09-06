/**
 * Constrói a lista da sidebar/drawer (itens, secções, accents) — espelho do
 * `gameNavItems` useMemo do legado. Ver docs/development/frontend/GAME_SHELL.md
 * e DECISIONS.md #80.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Briefcase,
  CalendarCheck,
  Clapperboard,
  Coins,
  Combine,
  Crown,
  Gamepad2,
  Gift,
  Grid3X3,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  Newspaper,
  Package,
  Scale,
  Server,
  ShoppingCart,
  Skull,
  Sparkles,
  Trophy,
  User as UserIcon,
  Wallet,
  Wrench
} from 'lucide-react';
import {
  DEFAULT_ALLOWED_PAGES,
  DEFAULT_GAME_NAV_LABELS,
  GAME_NAV_LABEL_KEYS,
  type GameNavLabelKey
} from '../../../shared/constants/gameNavLabels';
import type { User } from '../../../shared/types/auth';

export type GameView =
  | GameNavLabelKey
  | 'profile'
  | 'management'
  | 'merge'
  | 'calculator'
  | 'dashboard'
  | 'deposit_history';

/** All known game views (for session restore). */
export const VALID_GAME_VIEWS: readonly GameView[] = [
  ...GAME_NAV_LABEL_KEYS,
  'profile',
  'management',
  'merge',
  'calculator',
  'dashboard',
  'deposit_history'
];

export const GAME_LAST_VIEW_SS = 'lastView';

/** Restore last Hub tab from sessionStorage (legacy App.tsx). */
export function parseSavedGameView(raw: string | null | undefined): GameView {
  if (!raw || typeof raw !== 'string') return 'servers';
  const t = raw.trim();
  return (VALID_GAME_VIEWS as readonly string[]).includes(t) ? (t as GameView) : 'servers';
}

export function readSavedGameView(): GameView {
  try {
    return parseSavedGameView(sessionStorage.getItem(GAME_LAST_VIEW_SS));
  } catch {
    return 'servers';
  }
}

export function writeSavedGameView(view: GameView): void {
  try {
    sessionStorage.setItem(GAME_LAST_VIEW_SS, view);
  } catch {
    /* ignore */
  }
}

export type GameNavSectionKey = 'operacao' | 'economia' | 'hub';
export type GameNavTabAccent =
  | 'amber'
  | 'yellow'
  | 'red'
  | 'orange'
  | 'rose'
  | 'emerald'
  | 'sky'
  | 'violet';

export type GameNavItem = {
  key: GameView;
  label: string;
  icon: LucideIcon;
  accent: GameNavTabAccent;
  section: GameNavSectionKey;
  allowed: boolean;
  /** Shown in mobile drawer only — omitted from desktop sidebar. */
  mobileOnly?: boolean;
};

export const GAME_NAV_SECTION_ORDER: readonly GameNavSectionKey[] = ['hub', 'operacao', 'economia'];

export function getGameNavSectionLabels(t: (key: string) => string): Record<GameNavSectionKey, string> {
  return {
    operacao: t('nav.sectionOps'),
    economia: t('nav.sectionEconomy'),
    hub: t('nav.sectionHub')
  };
}

export function gameNavTabClass(isActive: boolean, accent: GameNavTabAccent): string {
  const base =
    'flex items-center gap-1.5 px-2.5 sm:px-3 py-2 rounded-xl text-[11px] sm:text-xs font-bold normal-case tracking-wide border transition-all duration-200 shrink-0';
  const inactive =
    'border-slate-700/80 text-slate-300 bg-slate-800/92 hover:bg-slate-700/95 hover:border-slate-500/80 hover:text-white';
  const active: Record<GameNavTabAccent, string> = {
    amber:
      'border-amber-400/65 text-amber-100 bg-gradient-to-b from-amber-700/80 to-[#17120b] shadow-[inset_0_1px_0_rgba(253,230,138,0.18)] ring-1 ring-amber-400/30',
    yellow:
      'border-yellow-500/60 text-yellow-100 bg-gradient-to-b from-yellow-700/80 to-[#17120b] ring-1 ring-yellow-400/30',
    red: 'border-red-400/60 text-red-100 bg-gradient-to-b from-red-700/75 to-[#170b0b] ring-1 ring-red-400/25',
    orange:
      'border-orange-400/60 text-orange-100 bg-gradient-to-b from-orange-700/75 to-[#17100a] ring-1 ring-orange-400/25',
    rose: 'border-rose-400/60 text-rose-100 bg-gradient-to-b from-rose-700/75 to-[#170b10] ring-1 ring-rose-400/25',
    emerald:
      'border-emerald-400/60 text-emerald-100 bg-gradient-to-b from-emerald-700/70 to-[#0b1511] ring-1 ring-emerald-400/25',
    sky: 'border-sky-400/60 text-sky-100 bg-gradient-to-b from-sky-700/70 to-[#09131a] ring-1 ring-sky-400/25',
    violet:
      'border-violet-400/60 text-violet-100 bg-gradient-to-b from-violet-700/70 to-[#110a17] ring-1 ring-violet-400/25'
  };
  return `${base} ${isActive ? active[accent] : inactive}`;
}

function labelFor(
  key: GameNavLabelKey,
  t?: (key: string) => string,
  overrides?: Partial<Record<GameNavLabelKey, string>>
): string {
  // Player locale wins over admin `ui_display_labels` (often single-language PT).
  if (t) return t(`nav.${key}`);
  const override = overrides?.[key];
  if (typeof override === 'string' && override.trim()) return override.trim();
  return DEFAULT_GAME_NAV_LABELS[key];
}

function extraNavLabel(t: ((key: string) => string) | undefined, key: string, fallback: string): string {
  return t ? t(`nav.${key}`) : fallback;
}

export function resolveAllowedPages(user: User | null): string[] {
  const pages: string[] = [...DEFAULT_ALLOWED_PAGES];
  // Áreas sempre acessíveis a jogadores autenticados (legado).
  for (const extra of ['partners', 'mini_blog', 'quests', 'offerwall', 'roleta', 'checkin']) {
    if (!pages.includes(extra)) pages.push(extra);
  }
  if (user?.isManagingAccount || user?.managerMode) {
    return pages.filter((p) =>
      [
        'servers',
        'dashboard',
        'management',
        'quests',
        'merge',
        'offerwall',
        'inventory',
        'lucky_store',
        'calculator',
        'checkin'
      ].includes(p)
    );
  }
  return pages;
}

export type BuildGameNavItemsOpts = {
  user: User;
  t?: (key: string) => string;
  labelOverrides?: Partial<Record<GameNavLabelKey, string>>;
  mergeEnabled?: boolean;
  accountManagerEnabled?: boolean;
  showRoletaInNav?: boolean;
};

export function buildGameNavItems(opts: BuildGameNavItemsOpts): GameNavItem[] {
  const {
    user,
    t,
    labelOverrides,
    mergeEnabled = user.mergeEnabled !== false,
    accountManagerEnabled = user.accountManagerEnabled === true,
    showRoletaInNav = true
  } = opts;
  const allowedPages = resolveAllowedPages(user);
  const has = (page: string) => allowedPages.includes(page);
  const isManagingAccount = !!user.isManagingAccount || !!user.managerMode;
  const isOperatorAdminOnly = !!(user.isAdmin && !user.isSuperAdmin);
  const managerOnlyKeys = new Set([
    'servers',
    'dashboard',
    'management',
    'quests',
    'merge',
    'offerwall',
    'inventory',
    'lucky_store',
    'calculator',
    'checkin'
  ]);
  const nav = (k: GameNavLabelKey) => labelFor(k, t, labelOverrides);

  const items: GameNavItem[] = [
    { key: 'servers', label: nav('servers'), icon: Server, accent: 'amber', section: 'operacao', allowed: has('servers') },
    {
      key: 'checkin',
      label: nav('checkin'),
      icon: CalendarCheck,
      accent: 'amber',
      section: 'operacao',
      // Sempre permitido no drawer mobile (incl. modo gerência). Desktop: banner
      // na Mining; sidebar só promove check-in em gerência (ver GameSidebar).
      allowed: has('checkin'),
      mobileOnly: true
    },
    {
      key: 'dashboard',
      label: extraNavLabel(t, 'dashboard', 'Dashboard'),
      icon: LayoutDashboard,
      accent: 'sky',
      section: 'operacao',
      allowed: false
    },
    {
      key: 'profile',
      label: nav('profile'),
      icon: UserIcon,
      accent: 'sky',
      section: 'operacao',
      // Legado: sidebar + top nav; oculto em gerência.
      allowed: !isManagingAccount
    },
    {
      key: 'management',
      label: nav('management'),
      icon: Briefcase,
      accent: 'sky',
      section: 'operacao',
      allowed: accountManagerEnabled
    },
    {
      key: 'inventory',
      label: nav('inventory'),
      icon: Package,
      accent: 'yellow',
      section: 'operacao',
      allowed: has('inventory')
    },
    {
      key: 'merge',
      label: extraNavLabel(t, 'merge', 'Merge'),
      icon: Combine,
      accent: 'amber',
      section: 'operacao',
      allowed: mergeEnabled && has('merge')
    },
    {
      key: 'hardware_store',
      label: nav('hardware_store'),
      icon: ShoppingCart,
      accent: 'amber',
      section: 'operacao',
      allowed: has('hardware_store')
    },
    {
      key: 'upgrade',
      label: nav('upgrade'),
      icon: Crown,
      accent: 'yellow',
      section: 'operacao',
      allowed: has('upgrade')
    },
    {
      key: 'black_market',
      label: nav('black_market'),
      icon: Skull,
      accent: 'red',
      section: 'economia',
      allowed: has('black_market')
    },
    {
      key: 'lucky_store',
      label: nav('lucky_store'),
      icon: Gift,
      accent: 'orange',
      section: 'economia',
      allowed: has('lucky_store')
    },
    {
      key: 'wallet',
      label: nav('wallet'),
      icon: Wallet,
      accent: 'orange',
      section: 'economia',
      allowed: has('wallet')
    },
    {
      key: 'ranking',
      label: nav('ranking'),
      icon: Trophy,
      accent: 'yellow',
      section: 'economia',
      allowed: has('ranking')
    },
    {
      key: 'calculator',
      label: extraNavLabel(t, 'calculator', 'Calculator'),
      icon: Wrench,
      accent: 'yellow',
      section: 'economia',
      allowed: !isOperatorAdminOnly
    },
    {
      key: 'transparency',
      label: nav('transparency'),
      icon: Scale,
      accent: 'emerald',
      section: 'hub',
      allowed: has('transparency')
    },
    {
      key: 'mini_blog',
      label: nav('mini_blog'),
      icon: Newspaper,
      accent: 'orange',
      section: 'hub',
      allowed: has('mini_blog')
    },
    {
      key: 'quests',
      label: nav('quests'),
      icon: ListChecks,
      accent: 'amber',
      section: 'hub',
      allowed: has('quests')
    },
    {
      key: 'support',
      label: nav('support'),
      icon: LifeBuoy,
      accent: 'sky',
      section: 'hub',
      allowed: has('support')
    },
    {
      key: 'partners',
      label: nav('partners'),
      icon: Clapperboard,
      accent: 'violet',
      section: 'hub',
      allowed: true
    },
    {
      key: 'partner_games',
      label: nav('partner_games'),
      icon: Grid3X3,
      accent: 'amber',
      section: 'hub',
      allowed: true
    },
    {
      key: 'offerwall',
      label: nav('offerwall'),
      icon: Coins,
      accent: 'emerald',
      section: 'hub',
      allowed: has('offerwall')
    },
    {
      key: 'arcade',
      label: nav('arcade'),
      icon: Gamepad2,
      accent: 'amber',
      section: 'hub',
      allowed: false
    },
    {
      key: 'roleta',
      label: nav('roleta'),
      icon: Sparkles,
      accent: 'rose',
      section: 'hub',
      allowed: has('roleta') && showRoletaInNav
    }
  ];

  return items.filter((item) => {
    if (!item.allowed) return false;
    if (isManagingAccount && !managerOnlyKeys.has(item.key)) return false;
    return true;
  });
}
