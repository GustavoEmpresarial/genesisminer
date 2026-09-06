import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  DollarSign,
  LogOut,
  Menu,
  Trophy,
  User as UserIcon,
  X,
  Zap
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  DiscordCommunityLink,
  TelegramCommunityLink
} from '../../../shared/icons/SocialBrandIcons';
import { LanguageSwitcher, useT } from '../../../shared/i18n';
import type { User } from '../../../shared/types/auth';
import { MiningCoinGlyph } from '../../../shared/ui/MiningCoinGlyph';
import { formatLiveTokenAmount, formatTokenAmount } from '../../../shared/utils/locale-format';
import type { GameView } from '../nav/buildGameNavItems';

export type TopNavTokenRow = {
  id: string;
  name: string;
  /** Opcional — fallback para `name` no ícone. */
  symbol?: string;
  balance: number;
  power: number;
  /** coins/s estimado — formatação live do saldo no ticker. */
  coinsPerSec?: number;
  color?: string;
};

type GameTopNavProps = {
  user: User;
  currentView: GameView;
  mobileMenuOpen: boolean;
  onToggleMobileMenu: () => void;
  onLogoClick: () => void;
  onNavigate: (view: GameView) => void;
  onDocs: () => void;
  onAdmin?: () => void;
  onLogout: () => void;
  usdcDisplay?: string;
  hashDisplay?: string;
  rankDisplay?: string | null;
  /** Tokens strip — catálogo + saldos + H/s por moeda (legado App.tsx). */
  tokenRows?: TopNavTokenRow[];
  /** Preferência BD (fonte de verdade); localStorage só como cache optimista. */
  persistedHighlightCoinId?: string | null;
  /** Persistência no servidor (fire-and-forget no parent). */
  onHighlightCoinChange?: (coinId: string) => void;
  /** Saúde do projecto (transparência) — piso 50. */
  projectHealth?: number | null;
  projectHealthBand?: 'excellent' | 'healthy' | 'neutral' | null;
};

const STAT_CELL =
  'flex shrink-0 flex-row items-center gap-1.5 border-r border-slate-300/80 px-2.5 py-1.5 last:border-r-0 dark:border-slate-700/80';

/** Célula do ticker de moedas — pode encolher no mobile sem invadir o menu. */
const TOKEN_STAT_CELL =
  'flex min-w-0 flex-1 flex-row items-center gap-1 border-r border-slate-300/80 px-1.5 py-1 last:border-r-0 sm:gap-1.5 sm:px-2.5 sm:py-1.5 dark:border-slate-700/80';

/** localStorage key prefix for per-user header coin highlight. */
export const HEADER_HIGHLIGHT_COIN_KEY_PREFIX = 'gm.headerHighlightCoin.';

export function headerHighlightStorageKey(userId: string): string {
  return `${HEADER_HIGHLIGHT_COIN_KEY_PREFIX}${userId}`;
}

function readStoredHighlightCoinId(userId: string): string | null {
  try {
    const raw = localStorage.getItem(headerHighlightStorageKey(userId));
    if (typeof raw === 'string' && raw.length > 0) return raw;
  } catch {
    /* private mode / blocked storage */
  }
  return null;
}

function writeStoredHighlightCoinId(userId: string, coinId: string): void {
  try {
    localStorage.setItem(headerHighlightStorageKey(userId), coinId);
  } catch {
    /* private mode / blocked storage */
  }
}

/** DB preferida; senão localStorage; senão null (UI cai no sortedTokens[0]). */
export function resolveInitialHighlightCoinId(
  userId: string,
  persistedHighlightCoinId?: string | null
): string | null {
  if (persistedHighlightCoinId != null) {
    const trimmed = persistedHighlightCoinId.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return readStoredHighlightCoinId(userId);
}

function fullTokenPrecision(val: number): string {
  if (!Number.isFinite(val) || val === 0) return '0';
  return String(val);
}

/** Resolve which token row to show in the header strip. */
export function resolveHighlightedToken(
  sortedTokens: TopNavTokenRow[],
  highlightedCoinId: string | null
): TopNavTokenRow | undefined {
  if (highlightedCoinId != null) {
    const selected = sortedTokens.find((x) => x.id === highlightedCoinId);
    if (selected) return selected;
    return sortedTokens[0];
  }
  return sortedTokens[0];
}

export function GameTopNav({
  user,
  currentView,
  mobileMenuOpen,
  onToggleMobileMenu,
  onLogoClick,
  onNavigate,
  onDocs,
  onAdmin,
  onLogout,
  usdcDisplay = '—',
  hashDisplay = '—',
  rankDisplay = null,
  tokenRows = [],
  persistedHighlightCoinId = null,
  onHighlightCoinChange,
  projectHealth = null,
  projectHealthBand = null
}: GameTopNavProps) {
  const t = useT();
  const isManaging = !!user.isManagingAccount || !!user.managerMode;
  const userId = String(user.id);
  const [coinsOpen, setCoinsOpen] = useState(false);
  const [highlightedCoinId, setHighlightedCoinId] = useState<string | null>(() =>
    resolveInitialHighlightCoinId(userId, persistedHighlightCoinId)
  );
  const tokensPanelId = useId();
  const tokensWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHighlightedCoinId(resolveInitialHighlightCoinId(userId, persistedHighlightCoinId));
  }, [userId, persistedHighlightCoinId]);

  const sortedTokens = [...tokenRows].sort((a, b) => {
    if (b.power !== a.power) return b.power - a.power;
    return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
  });

  // Prefer persisted selection even when all powers are 0 (check-in freeze).
  const highlighted = resolveHighlightedToken(sortedTokens, highlightedCoinId);

  useEffect(() => {
    if (!coinsOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!tokensWrapRef.current?.contains(e.target as Node)) {
        setCoinsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCoinsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [coinsOpen]);

  const roleLabel = user.isAdmin ? t('shell.administrator') : t('shell.operator');

  const toggleMobileMenu = () => {
    setCoinsOpen(false);
    onToggleMobileMenu();
  };

  return (
    <header className="relative z-50 h-14 shrink-0 overflow-visible border-b border-slate-200 bg-white/90 shadow-sm backdrop-blur-md transition-colors duration-300 dark:border-amber-900/30 dark:bg-slate-900/90">
      {/* 3 zonas: marca | stats | menu — no mobile o menu fica por cima do ticker */}
      <div className="mx-auto grid h-full w-full min-w-0 max-w-7xl grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 px-2 py-0 sm:gap-2.5 sm:px-4">
        {/* Brand */}
        <div className="relative z-[60] flex min-w-0 shrink-0 items-center">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left sm:gap-2.5"
            aria-label={t('common.homeAria')}
            onClick={onLogoClick}
          >
            <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-slate-900 shadow-md shadow-amber-600/25 ring-2 ring-amber-500/50 sm:h-9 sm:w-9">
              <img
                src="/img/favicon/genesis-miner-logo.webp"
                onError={(e) => {
                  e.currentTarget.onerror = null;
                  e.currentTarget.src = '/genesis-miner-logo.png';
                }}
                alt=""
                className="h-full w-full object-cover"
                width={36}
                height={36}
                aria-hidden
              />
            </div>
            <div className="min-w-0 text-left hidden sm:block">
              <p className="truncate bg-gradient-to-r from-amber-600 to-orange-600 bg-clip-text text-sm font-bold leading-none text-transparent dark:from-amber-400 dark:to-orange-400">
                {t('landing.brand')}
              </p>
            </div>
          </button>
          {projectHealth != null ? (
            <button
              type="button"
              onClick={() => onNavigate('transparency')}
              title={t('shell.projectHealthTitle')}
              aria-label={t('shell.projectHealthTitle')}
              className={`ml-1 inline-flex shrink-0 items-center gap-0.5 rounded-md border px-1.5 py-1 font-mono text-[11px] font-black tabular-nums leading-none transition hover:bg-slate-100 dark:hover:bg-slate-800 ${
                projectHealthBand === 'excellent'
                  ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                  : projectHealthBand === 'healthy'
                    ? 'border-lime-500/40 text-lime-600 dark:text-lime-400'
                    : 'border-amber-500/40 text-amber-600 dark:text-amber-300'
              }`}
            >
              <img
                src="/transparency-art/heart.png"
                alt=""
                className="h-4 w-4 shrink-0 object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)] [image-rendering:pixelated]"
                aria-hidden
              />
              {projectHealth}
            </button>
          ) : null}
        </div>

        {/* Stats — centrados; moeda legível no mobile, menu isolado à direita */}
        <div className="flex min-w-0 justify-center px-0.5">
          <div className="flex max-w-full min-w-0 w-full sm:w-auto items-stretch overflow-visible rounded-lg border border-slate-200/90 bg-slate-100/90 shadow-inner dark:border-slate-700/60 dark:bg-slate-800/60">
            {/* Tokens */}
            <div ref={tokensWrapRef} className={`${TOKEN_STAT_CELL} relative border-r-0 sm:border-r sm:flex-none sm:max-w-[18rem]`}>
              <button
                type="button"
                onClick={() => setCoinsOpen((o) => !o)}
                className="flex w-full min-w-0 items-center gap-1.5 rounded text-left transition hover:bg-slate-200/80 dark:hover:bg-slate-700/60"
                aria-expanded={coinsOpen}
                aria-controls={tokensPanelId}
                aria-label={t('shell.tokens')}
              >
                {sortedTokens.length === 0 || !highlighted ? (
                  <>
                    <span className="font-mono text-xs leading-none text-slate-500">—</span>
                    {coinsOpen ? (
                      <ChevronUp size={14} className="shrink-0" aria-hidden />
                    ) : (
                      <ChevronDown size={14} className="shrink-0" aria-hidden />
                    )}
                  </>
                ) : (
                  <>
                    <MiningCoinGlyph
                      coin={{
                        id: highlighted.id,
                        name: highlighted.name,
                        symbol: highlighted.symbol || highlighted.name,
                        color: highlighted.color
                      }}
                      size={18}
                    />
                    {/* Mobile: saldo + H/s em 2 linhas para não cortar */}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-none sm:hidden">
                      <span
                        className="truncate font-mono text-xs font-bold tabular-nums text-slate-800 dark:text-slate-100"
                        title={fullTokenPrecision(highlighted.balance)}
                      >
                        {formatLiveTokenAmount(highlighted.balance, highlighted.coinsPerSec ?? 0)}
                      </span>
                      <span
                        className="truncate font-mono text-[10px] font-semibold tabular-nums text-yellow-600 dark:text-yellow-400"
                        title={fullTokenPrecision(highlighted.power)}
                      >
                        {formatTokenAmount(highlighted.power)} H/s
                      </span>
                    </span>
                    {/* Desktop / sm+: uma linha */}
                    <span
                      className="hidden min-w-0 whitespace-nowrap font-mono text-sm font-semibold leading-none tabular-nums text-slate-700 sm:inline dark:text-slate-200"
                      title={fullTokenPrecision(highlighted.balance)}
                    >
                      {formatLiveTokenAmount(highlighted.balance, highlighted.coinsPerSec ?? 0)}
                      {highlighted.power > 0 ? (
                        <span
                          className="text-[10px] text-yellow-600 dark:text-yellow-400"
                          title={fullTokenPrecision(highlighted.power)}
                        >
                          {' · '}
                          {formatTokenAmount(highlighted.power)} H/s
                        </span>
                      ) : null}
                    </span>
                    {coinsOpen ? (
                      <ChevronUp size={14} className="shrink-0" aria-hidden />
                    ) : (
                      <ChevronDown size={14} className="shrink-0" aria-hidden />
                    )}
                  </>
                )}
              </button>

              {coinsOpen && sortedTokens.length > 0 ? (
                <ul
                  id={tokensPanelId}
                  role="listbox"
                  className="custom-scrollbar absolute left-1/2 top-[calc(100%+0.35rem)] z-[70] max-h-[min(50vh,20rem)] w-[min(20rem,calc(100vw-4.5rem))] -translate-x-1/2 space-y-0.5 overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl sm:left-0 sm:translate-x-0 dark:border-slate-600 dark:bg-slate-900"
                >
                  {sortedTokens.map((c) => {
                    const isActive = (highlightedCoinId ?? highlighted?.id) === c.id;
                    const hot = c.power > 0;
                    return (
                      <li key={c.id} role="option" aria-selected={isActive}>
                        <button
                          type="button"
                          onClick={() => {
                            setHighlightedCoinId(c.id);
                            writeStoredHighlightCoinId(userId, c.id);
                            onHighlightCoinChange?.(c.id);
                            setCoinsOpen(false);
                          }}
                          className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                            isActive
                              ? 'bg-amber-500/15 ring-1 ring-amber-500/35'
                              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          <MiningCoinGlyph
                            coin={{ id: c.id, name: c.name, symbol: c.symbol || c.name, color: c.color }}
                            size={22}
                          />
                          <span
                            className={`min-w-0 truncate text-sm font-bold leading-tight ${
                              isActive
                                ? 'text-amber-700 dark:text-amber-300'
                                : 'text-slate-800 dark:text-slate-100'
                            }`}
                            title={c.name}
                          >
                            {c.name}
                          </span>
                          <span className="flex flex-col items-end gap-0.5 font-mono text-xs leading-snug tabular-nums">
                            <span
                              className={
                                c.balance > 0
                                  ? 'font-semibold text-amber-800 dark:text-amber-200'
                                  : 'text-slate-500'
                              }
                              title={fullTokenPrecision(c.balance)}
                            >
                              {formatLiveTokenAmount(c.balance, c.coinsPerSec ?? 0)}
                            </span>
                            <span
                              className={`inline-flex items-center gap-0.5 ${
                                hot ? 'text-yellow-600 dark:text-yellow-400' : 'text-slate-500'
                              }`}
                              title={fullTokenPrecision(c.power)}
                            >
                              <Zap size={11} className="shrink-0 opacity-80" aria-hidden />
                              {formatTokenAmount(c.power)}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>

            {/* USDC / Hash / Ranking — a partir de sm */}
            <div className={`${STAT_CELL} hidden sm:flex`}>
              <span className="inline-flex items-center gap-1 font-mono text-sm font-bold tabular-nums leading-none text-green-700 dark:text-green-400">
                <DollarSign size={12} className="shrink-0" aria-hidden />
                {usdcDisplay}
              </span>
            </div>

            <div className={`${STAT_CELL} hidden sm:flex`}>
              <span className="inline-flex items-center gap-1 font-mono text-sm font-semibold tabular-nums leading-none text-slate-800 dark:text-slate-100">
                <Zap size={12} className="shrink-0 text-yellow-500" aria-hidden />
                {hashDisplay}
              </span>
            </div>

            <button
              type="button"
              onClick={() => onNavigate('ranking')}
              className="hidden shrink-0 flex-row items-center gap-1.5 rounded-r-lg px-2 py-0.5 transition hover:bg-yellow-500/10 sm:flex"
              title={t('shell.rankingGlobalTitle')}
            >
              <Trophy size={12} strokeWidth={2.5} className="shrink-0 text-yellow-700 dark:text-yellow-400" aria-hidden />
              <span className="font-mono text-sm font-black tabular-nums leading-none text-yellow-800 dark:text-yellow-300">
                {rankDisplay != null ? `#${rankDisplay}` : '—'}
              </span>
            </button>
          </div>
        </div>

        {/* Direita: menu mobile por cima do ticker + ações desktop */}
        <div className="relative z-[90] flex shrink-0 items-center justify-end gap-1">
          <button
            type="button"
            onClick={toggleMobileMenu}
            className="rounded-lg border border-slate-200 bg-white/95 p-1.5 text-slate-600 shadow-sm transition-colors hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900/95 dark:text-slate-200 dark:hover:bg-slate-800 lg:hidden"
            aria-label={mobileMenuOpen ? t('shell.closeMenu') : t('shell.openMenu')}
          >
            {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>

          <div className="hidden items-center gap-0.5 md:flex">
            <DiscordCommunityLink size={16} />
            <TelegramCommunityLink size={16} />
            <button
              type="button"
              onClick={onDocs}
              className="rounded-lg p-1 text-slate-500 transition hover:bg-slate-200 dark:hover:bg-slate-800"
              title={t('common.docs')}
            >
              <BookOpen size={16} />
            </button>
            <LanguageSwitcher className="[&_select]:h-8 [&_select]:py-1 [&_select]:text-xs [&_select]:leading-none [&_svg]:h-4 [&_svg]:w-4" />

            <div className="ml-1 flex items-center gap-1.5 border-l border-slate-200 pl-2 dark:border-slate-700">
              {!isManaging && (
                <button
                  type="button"
                  onClick={() => onNavigate('profile')}
                  className={`rounded-lg p-1 transition-colors ${
                    currentView === 'profile'
                      ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400'
                      : 'text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800'
                  }`}
                  title={t('shell.myProfile')}
                >
                  <UserIcon size={16} />
                </button>
              )}
              <div
                className={`max-w-[8.5rem] truncate text-sm font-bold leading-none ${
                  user.isAdmin ? 'text-red-500' : 'text-amber-700 dark:text-amber-400'
                }`}
                title={`${roleLabel}: ${user.username}`}
              >
                {user.username}
              </div>
              {(user.isAdmin || user.isImpersonating) && onAdmin && (
                <button
                  type="button"
                  onClick={onAdmin}
                  className="text-xs font-bold text-red-500 hover:text-red-400 sm:text-sm"
                >
                  {t('shell.adminPanel')}
                </button>
              )}
              <button
                type="button"
                onClick={onLogout}
                className="rounded-lg border border-red-200 bg-red-100 p-1 text-red-600 transition hover:bg-red-200 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40"
                title={t('shell.logout')}
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
