/**
 * Shell pós-login: top nav + sidebar/drawer + área de conteúdo.
 * Extraído do monólito `legacy/frontend/App.tsx` (DECISIONS #80).
 * Conteúdo por view: `GameViewOutlet` — ver GAME_SHELL.md.
 * Aba ativa: URL (`/wallet`, …) + `sessionStorage.lastView` fallback.
 * Mini Blog rail direita (`xl+`): DECISIONS #102.
 * Flags / stubs / USDC seed: DECISIONS #106.
 * Strip Tokens / Hash / Ranking: DECISIONS #110 — fetch sob pedido (sem poll).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Newspaper } from 'lucide-react';
import type { User } from '../../../shared/types/auth';
import { useI18n, useT } from '../../../shared/i18n';
import { postAccountManagerLeave } from '../../gerente';
import { getPendingInAppAnnouncements, dismissInAppAnnouncement } from '../../../shared/api/announcements';
import { getPlayerGameHeader, patchHeaderHighlightCoin } from '../../../shared/api/player-game';
import { getTransparencyHealth } from '../../../shared/api/transparency';
import { getMyGlobalRanking } from '../../../shared/api/quests';
import { formatHashTotal, formatUsdcAmount } from '../../../shared/utils/locale-format';
import { MiniBlogPage } from '../../mini-blog';
import { InAppAnnouncementModal, type InAppAnnouncement } from '../../announcements';
import { PlayerChatWidget } from '../../chat';
import { ConnectWalletModal, WalletGatePopup, useWalletGate } from '../../wallet';
import { GameMobileDrawer } from './GameMobileDrawer';
import { GameSidebar } from './GameSidebar';
import { GameTopNav, type TopNavTokenRow } from './GameTopNav';
import { GameViewOutlet } from './GameViewOutlet';
import {
  buildGameNavItems,
  readSavedGameView,
  writeSavedGameView,
  type GameView
} from '../nav/buildGameNavItems';
import { GAME_NAV_LABEL_KEYS, type GameNavLabelKey } from '../../../shared/constants/gameNavLabels';
import { getDisplayLabelsRaw, parseShowRoletaTabNavFromDisplayLabels } from '../../../shared/api/admin-legacy';
import { gameViewFromPath, partnerGameSlugFromPath, pathForGameView, pathForPartnerGamePlayer, pushPath, replacePath } from '../../../app/pathRouting';
import {
  estimateLiveCoinBalance,
  lastCompletedTenMinuteUtcGrid,
  LIVE_BALANCE_TICK_MS
} from '../lib/liveCoinBalanceEstimate';

function initialGameView(): GameView {
  if (typeof window !== 'undefined') {
    if (partnerGameSlugFromPath(window.location.pathname)) return 'partner_games';
    const fromUrl = gameViewFromPath(window.location.pathname);
    if (fromUrl) return fromUrl;
  }
  return readSavedGameView();
}

const GAME_NAV_EXPANDED_LS = 'minestation.gameNavExpanded';
const MINI_BLOG_EXPANDED_LS = 'minestation.miniBlogExpanded';
/** Debounce após mudança de hash (evento local) — não é poll periódico. */
const RANK_REFRESH_DEBOUNCE_MS = 1_200;

/** Views that take full width — no right Mini Blog rail (legado App.tsx). */
const HIDE_MINI_BLOG_SIDEBAR: ReadonlySet<GameView> = new Set([
  'dashboard',
  'partners',
  'partner_games',
  'mini_blog'
]);

type GameShellProps = {
  user: User;
  onLogout: () => void;
  onDocs: () => void;
  onAdmin?: () => void;
  /** Fail-closed: false/undefined → caller may reload. */
  onSessionRefresh?: () => boolean | Promise<boolean>;
  onUserUpdate?: (partial: { username?: string; polygonWallet?: string | null }) => void;
};

function viewLabel(view: GameView, t: (key: string) => string): string {
  if ((GAME_NAV_LABEL_KEYS as readonly string[]).includes(view)) {
    return t(`nav.${view as GameNavLabelKey}`);
  }
  if (view === 'profile') return t('nav.profile');
  if (view === 'management') return t('nav.management');
  if (view === 'merge') return t('nav.merge');
  if (view === 'calculator') return t('nav.calculator');
  if (view === 'dashboard') return t('nav.dashboard');
  return String(view);
}

export function GameShell({
  user,
  onLogout,
  onDocs,
  onAdmin,
  onSessionRefresh,
  onUserUpdate
}: GameShellProps) {
  const t = useT();
  const { locale } = useI18n();
  const [currentView, setCurrentView] = useState<GameView>(() => initialGameView());
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [usdc, setUsdc] = useState<number | null>(null);
  const [totalHash, setTotalHash] = useState<number | null>(null);
  const [tokenRows, setTokenRows] = useState<TopNavTokenRow[]>([]);
  const [estCoinsPerSecByCoinId, setEstCoinsPerSecByCoinId] = useState<Record<string, number>>({});
  const [headerLiveAccrualAnchorMs, setHeaderLiveAccrualAnchorMs] = useState(0);
  const [headerHighlightCoinId, setHeaderHighlightCoinId] = useState<string | null>(null);
  const [balanceTick, setBalanceTick] = useState(0);
  const [myGlobalRank, setMyGlobalRank] = useState<number | null>(null);
  const [projectHealth, setProjectHealth] = useState<number | null>(null);
  const [projectHealthBand, setProjectHealthBand] = useState<
    'excellent' | 'healthy' | 'neutral' | null
  >(null);
  const [announcementQueue, setAnnouncementQueue] = useState<InAppAnnouncement[]>([]);
  const [dismissingAnnouncement, setDismissingAnnouncement] = useState(false);
  const [navExpanded, setNavExpanded] = useState(() => {
    try {
      const v = localStorage.getItem(GAME_NAV_EXPANDED_LS);
      if (v === '0') return false;
      if (v === '1') return true;
    } catch {
      /* ignore */
    }
    return true;
  });
  const [miniBlogExpanded, setMiniBlogExpanded] = useState(() => {
    try {
      const v = localStorage.getItem(MINI_BLOG_EXPANDED_LS);
      if (v === '0') return false;
      if (v === '1') return true;
    } catch {
      /* ignore */
    }
    return true;
  });
  const [showRoletaInNav, setShowRoletaInNav] = useState(true);
  const walletGate = useWalletGate(user);
  const [walletPopupDismissed, setWalletPopupDismissed] = useState(false);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [partnerPlayerSlug, setPartnerPlayerSlug] = useState(() =>
    typeof window !== 'undefined' ? partnerGameSlugFromPath(window.location.pathname) : null
  );

  /** Reappear on every new tab/navigation while the gate stays closed. */
  useEffect(() => {
    setWalletPopupDismissed(false);
  }, [currentView]);

  const items = useMemo(
    () =>
      buildGameNavItems({
        user,
        t,
        accountManagerEnabled: user.accountManagerEnabled === true,
        mergeEnabled: user.mergeEnabled !== false,
        showRoletaInNav
      }),
    [user, t, showRoletaInNav]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const raw = await getDisplayLabelsRaw();
      if (cancelled) return;
      setShowRoletaInNav(parseShowRoletaTabNavFromDisplayLabels(raw));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyHeaderSnapshot = useCallback(async () => {
    const snap = await getPlayerGameHeader();
    if (!snap) return;
    setUsdc(snap.usdc);
    setTotalHash(snap.totalHash);
    setEstCoinsPerSecByCoinId(snap.estCoinsPerSecByCoinId);
    setHeaderLiveAccrualAnchorMs(
      Number.isFinite(snap.liveAccrualAnchorMs) && snap.liveAccrualAnchorMs > 0
        ? snap.liveAccrualAnchorMs
        : lastCompletedTenMinuteUtcGrid(Date.now())
    );
    setHeaderHighlightCoinId(snap.headerHighlightCoinId);
    const rows: TopNavTokenRow[] = snap.miningCoins.map((c) => {
      const localP = snap.hashByCoinId[c.id] || 0;
      const coinsPerSec = snap.estCoinsPerSecByCoinId[c.id] || 0;
      return {
        id: c.id,
        name: c.name,
        symbol: c.name,
        balance: snap.coinBalances[c.id] || 0,
        power: Number.isFinite(localP) ? localP : 0,
        coinsPerSec: Number.isFinite(coinsPerSec) ? coinsPerSec : 0
      };
    });
    setTokenRows(rows);
  }, []);

  const onHighlightCoinChange = useCallback((coinId: string) => {
    setHeaderHighlightCoinId(coinId);
    void patchHeaderHighlightCoin(coinId);
  }, []);

  /** Ticker 1s — só re-render; saldo = estimativa local (sem poll / WS). */
  useEffect(() => {
    const id = window.setInterval(() => {
      setBalanceTick((n) => n + 1);
    }, LIVE_BALANCE_TICK_MS);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  const liveTokenRows = useMemo(() => {
    void balanceTick;
    const nowMs = Date.now();
    return tokenRows.map((row) => {
      const coinsPerSec = estCoinsPerSecByCoinId[row.id] || row.coinsPerSec || 0;
      return {
        ...row,
        coinsPerSec,
        balance: estimateLiveCoinBalance({
          serverBalance: row.balance,
          coinsPerSec,
          accrualAnchorMs: headerLiveAccrualAnchorMs,
          nowMs
        })
      };
    });
  }, [tokenRows, estCoinsPerSecByCoinId, headerLiveAccrualAnchorMs, balanceTick]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await applyHeaderSnapshot();
    })();
    return () => {
      cancelled = true;
    };
  }, [applyHeaderSnapshot, user.id, user.isManagingAccount, user.managerMode, user.actingAsOwnerId]);

  useEffect(() => {
    let cancelled = false;
    void getTransparencyHealth()
      .then((h) => {
        if (cancelled) return;
        setProjectHealth(h.health);
        setProjectHealthBand(h.band);
      })
      .catch(() => {
        if (!cancelled) {
          setProjectHealth(null);
          setProjectHealthBand(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await getPendingInAppAnnouncements();
      if (!cancelled) setAnnouncementQueue(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getMyGlobalRanking({ fresh: true });
      if (!cancelled && res.ok) setMyGlobalRank(res.position);
    })();
    return () => {
      cancelled = true;
    };
  }, [user.id, user.isManagingAccount, user.managerMode, user.actingAsOwnerId]);

  /** Hash mudou (após fetch/ação) → recalcula posição com debounce — sem timer periódico. */
  useEffect(() => {
    if (totalHash == null) return;
    let cancelled = false;
    const tmr = window.setTimeout(() => {
      void (async () => {
        const res = await getMyGlobalRanking({ fresh: true });
        if (!cancelled && res.ok) setMyGlobalRank(res.position);
      })();
    }, RANK_REFRESH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(tmr);
    };
  }, [totalHash]);

  useEffect(() => {
    writeSavedGameView(currentView);
  }, [currentView]);

  /** URL ↔ aba no mount: deep link de jogo parceiro ou alinha URL à view. */
  useEffect(() => {
    const slug = partnerGameSlugFromPath(window.location.pathname);
    if (slug) {
      setCurrentView('partner_games');
      setPartnerPlayerSlug(slug);
      return;
    }
    const fromUrl = gameViewFromPath(window.location.pathname);
    if (!fromUrl) {
      replacePath(pathForGameView(initialGameView()));
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const slug = partnerGameSlugFromPath(window.location.pathname);
      if (slug) {
        setCurrentView('partner_games');
        setPartnerPlayerSlug(slug);
        return;
      }
      const fromUrl = gameViewFromPath(window.location.pathname);
      if (fromUrl) {
        setCurrentView(fromUrl);
        setPartnerPlayerSlug(null);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  /** Feature desligada no server → não ficar preso na view. */
  useEffect(() => {
    if (currentView === 'management' && user.accountManagerEnabled !== true) {
      replacePath(pathForGameView('servers'));
      setCurrentView('servers');
      return;
    }
    if (currentView === 'merge' && user.mergeEnabled === false) {
      replacePath(pathForGameView('servers'));
      setCurrentView('servers');
    }
  }, [currentView, user.accountManagerEnabled, user.mergeEnabled]);

  const toggleNavExpanded = useCallback(() => {
    setNavExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(GAME_NAV_EXPANDED_LS, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const setMiniBlogExpandedPersist = useCallback((next: boolean) => {
    setMiniBlogExpanded(next);
    try {
      localStorage.setItem(MINI_BLOG_EXPANDED_LS, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  const onNavigate = useCallback(
    (view: GameView) => {
      if (view === 'management' && user.accountManagerEnabled !== true) return;
      if (view === 'merge' && user.mergeEnabled === false) return;
      pushPath(pathForGameView(view));
      setCurrentView(view);
      setPartnerPlayerSlug(null);
    },
    [user.accountManagerEnabled, user.mergeEnabled]
  );

  const onOpenPartnerGame = useCallback((slug: string) => {
    pushPath(pathForPartnerGamePlayer(slug));
    setCurrentView('partner_games');
    setPartnerPlayerSlug(slug);
  }, []);

  const onBackToPartnerHub = useCallback(() => {
    pushPath(pathForGameView('partner_games'));
    setCurrentView('partner_games');
    setPartnerPlayerSlug(null);
  }, []);

  const refreshSessionAndUsdc = useCallback(async () => {
    setUsdc(null);
    setTotalHash(null);
    setTokenRows([]);
    setMyGlobalRank(null);
    if (onSessionRefresh) {
      const ok = await onSessionRefresh();
      if (!ok) return;
    } else {
      window.location.reload();
      return;
    }
    await applyHeaderSnapshot();
  }, [onSessionRefresh, applyHeaderSnapshot]);

  const currentViewLabel = viewLabel(currentView, t);
  const showMiniBlogSidebar = !HIDE_MINI_BLOG_SIDEBAR.has(currentView);
  const isManagingAccount = Boolean(user.isManagingAccount || user.managerMode);
  const currentAnnouncement = announcementQueue[0] ?? null;

  const dismissCurrentAnnouncement = useCallback(async () => {
    const current = announcementQueue[0];
    if (!current) return;
    setDismissingAnnouncement(true);
    const ok = await dismissInAppAnnouncement(current.id);
    setDismissingAnnouncement(false);
    if (!ok) return;
    setAnnouncementQueue((prev) => prev.slice(1));
  }, [announcementQueue]);

  const leaveManagedAccount = useCallback(async () => {
    await postAccountManagerLeave();
    await refreshSessionAndUsdc();
  }, [refreshSessionAndUsdc]);

  const usdcDisplay =
    usdc == null
      ? '—'
      : formatUsdcAmount(usdc, locale, { minFractionDigits: 2, maxFractionDigits: 2 });
  const hashDisplay = totalHash == null ? '—' : formatHashTotal(totalHash);
  const rankDisplay = myGlobalRank != null ? String(myGlobalRank) : null;

  return (
    <div className="flex h-[100dvh] min-h-0 w-full min-w-0 max-w-full flex-col overflow-hidden bg-slate-50 font-sans text-slate-800 transition-colors duration-300 selection:bg-amber-500/30 dark:bg-[#0f0c08] dark:text-slate-200">
      <a
        href="#main-content"
        className="fixed left-4 top-0 z-[9999] -translate-y-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-stone-950 shadow-lg outline-none ring-2 ring-amber-200 transition focus:translate-y-4 focus:ring-offset-2 focus:ring-offset-[#0f0c08]"
      >
        {t('shell.skipToMain')}
      </a>

      <GameTopNav
        user={user}
        currentView={currentView}
        mobileMenuOpen={mobileMenuOpen}
        onToggleMobileMenu={() => setMobileMenuOpen((v) => !v)}
        onLogoClick={() => onNavigate('servers')}
        onNavigate={onNavigate}
        onDocs={onDocs}
        onAdmin={onAdmin}
        onLogout={onLogout}
        usdcDisplay={usdcDisplay}
        hashDisplay={hashDisplay}
        rankDisplay={rankDisplay}
        tokenRows={liveTokenRows}
        persistedHighlightCoinId={headerHighlightCoinId}
        onHighlightCoinChange={onHighlightCoinChange}
        projectHealth={projectHealth}
        projectHealthBand={projectHealthBand}
      />

      {isManagingAccount ? (
        <div className="sticky top-0 z-[65] flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-950/90 px-4 py-2 text-sm text-amber-100 backdrop-blur">
          <span>
            {t('shell.managingAccountBanner', { username: user.username })}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-amber-300/50 bg-amber-900/50 px-3 py-1 font-bold text-amber-50 hover:bg-amber-800/70 lg:hidden"
              onClick={() => onNavigate('checkin')}
            >
              {t('nav.checkin')}
            </button>
            <button
              type="button"
              className="rounded-md bg-amber-500 px-3 py-1 font-bold text-stone-950 hover:bg-amber-400"
              onClick={() => void leaveManagedAccount()}
            >
              {t('shell.leaveManagedAccount')}
            </button>
          </div>
        </div>
      ) : null}

      <GameMobileDrawer
        open={mobileMenuOpen}
        user={user}
        items={items}
        currentView={currentView}
        onClose={() => setMobileMenuOpen(false)}
        onNavigate={onNavigate}
        onDocs={onDocs}
        onAdmin={onAdmin}
        onLogout={onLogout}
      />

      <div
        className={`relative flex h-full min-w-0 w-full flex-1 overflow-hidden ${
          showMiniBlogSidebar ? 'justify-center' : 'justify-start'
        }`}
      >
        <GameSidebar
          items={items}
          currentView={currentView}
          expanded={navExpanded}
          onToggleExpanded={toggleNavExpanded}
          onNavigate={onNavigate}
          promoteMobileOnlyKeys={isManagingAccount ? new Set(['checkin']) : undefined}
        />

        <main
          id="main-content"
          className="custom-scrollbar relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto font-mono"
        >
          <GameViewOutlet
            view={currentView}
            user={user}
            viewLabel={currentViewLabel}
            t={t}
            onNavigate={onNavigate}
            onUsdcChange={setUsdc}
            usdcBalance={usdc ?? 0}
            onSessionRefresh={refreshSessionAndUsdc}
            onUserUpdate={onUserUpdate}
            hasWallet={walletGate.hasWallet}
            onOpenWalletConnect={() => setWalletModalOpen(true)}
            onHeaderRefresh={applyHeaderSnapshot}
            partnerGameSlug={partnerPlayerSlug}
            onOpenPartnerGame={onOpenPartnerGame}
            onBackToPartnerHub={onBackToPartnerHub}
          />
        </main>

        {showMiniBlogSidebar ? (
          miniBlogExpanded ? (
            <aside
              className="sticky top-24 mx-3 mt-4 hidden h-[calc(100vh-7rem)] max-h-[calc(100vh-7rem)] w-[min(100%,20rem)] min-w-[17rem] max-w-[20rem] shrink-0 self-start transition-[width] duration-300 xl:flex lg:mx-4"
              aria-label={t('miniBlog.title')}
            >
              <MiniBlogPage variant="sidebar" onCollapse={() => setMiniBlogExpandedPersist(false)} />
            </aside>
          ) : (
            <aside
              className="sticky top-24 mx-2 mt-4 hidden h-[calc(100vh-7rem)] max-h-[calc(100vh-7rem)] w-12 shrink-0 self-start xl:flex lg:mx-3"
              aria-label={t('miniBlog.title')}
            >
              <button
                type="button"
                onClick={() => setMiniBlogExpandedPersist(true)}
                title={t('miniBlog.expand')}
                aria-label={t('miniBlog.expand')}
                aria-expanded={false}
                className="flex h-full w-full flex-col items-center gap-3 rounded-xl border-2 border-orange-500/35 bg-gradient-to-b from-slate-900/90 to-slate-950/95 px-1 py-4 text-orange-300 shadow-[0_0_24px_-8px_rgba(251,146,60,0.35)] transition hover:border-orange-400/55 hover:bg-orange-950/40 hover:text-orange-200"
              >
                <Newspaper size={20} className="shrink-0" />
                <span
                  className="text-[10px] font-black uppercase tracking-[0.18em] text-orange-200/90"
                  style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
                >
                  {t('miniBlog.title')}
                </span>
              </button>
            </aside>
          )
        ) : null}
      </div>

      <InAppAnnouncementModal
        announcement={currentAnnouncement}
        onDismiss={() => void dismissCurrentAnnouncement()}
        dismissing={dismissingAnnouncement}
      />

      <WalletGatePopup
        open={
          !walletGate.hasWallet &&
          currentView !== 'servers' &&
          !walletPopupDismissed &&
          !walletModalOpen
        }
        onDismiss={() => setWalletPopupDismissed(true)}
        onConnect={() => setWalletModalOpen(true)}
      />

      <ConnectWalletModal
        open={walletModalOpen}
        onClose={() => setWalletModalOpen(false)}
        onUserUpdate={onUserUpdate}
      />

      {!user.isImpersonating ? (
        <PlayerChatWidget
          currentUserId={Number(user.id)}
          currentUsername={user.username}
          realUserId={
            user.isManagingAccount || user.managerMode
              ? Number(user.managerUserId) || Number(user.id)
              : Number(user.id)
          }
          isManagingAccount={!!user.isManagingAccount || !!user.managerMode}
        />
      ) : null}
    </div>
  );
}
