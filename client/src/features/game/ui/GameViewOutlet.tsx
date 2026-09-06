/**
 * Maps `GameView` → page content. Keeps `GameShell` free of a growing ternary.
 * New ported views: add a branch here + document in GAME_SHELL.md / DECISIONS.
 */
import type { User } from '../../../shared/types/auth';
import type { TranslateFn } from '../../../shared/i18n/I18nProvider';
import { getWheelState } from '../../../shared/api/wheel';
import { HubPageFrame } from '../../../shared/ui/HubPageFrame';
import { GerentePage } from '../../gerente';
import { ArcadePage, PartnerGamePlayerPage, PartnerGamesPage } from '../../arcade';
import { BlackMarketPage } from '../../black-market';
import { CalculatorPage } from '../../calculator';
import { Dashboard } from '../../dashboard';
import { InventoryPage } from '../../inventory';
import { LuckyBoxesPage } from '../../lucky-boxes';
import { MergePage } from '../../merge';
import { MiniBlogPage } from '../../mini-blog';
import { OfferwallPage } from '../../offerwall';
import { PartnersPage } from '../../partners';
import { ProfilePage } from '../../profile';
import { QuestsPage } from '../../quests';
import { RankingPage } from '../../ranking';
import { RoletaPage } from '../../roleta';
import { MiningPage } from '../../servers/ui/MiningPage';
import { CheckinPage } from '../../checkin';
import { ShopPage } from '../../shop';
import { SupportPage } from '../../support';
import { TransparencyPage } from '../../transparency';
import { UpgradesPage } from '../../upgrades';
import { WalletPage, WithdrawalHistoryPage, DepositHistoryPage } from '../../wallet';
import type { GameView } from '../nav/buildGameNavItems';
import { ROLETA_PREFILL_CODE_SS } from '../../../shared/constants/roletaPrefill';

export type GameViewOutletProps = {
  view: GameView;
  user: User;
  viewLabel: string;
  t: TranslateFn;
  onNavigate: (view: GameView) => void;
  onUsdcChange: (usdc: number) => void;
  usdcBalance: number;
  onSessionRefresh?: () => void | Promise<void> | boolean | Promise<boolean>;
  onUserUpdate?: (partial: { username?: string; polygonWallet?: string | null }) => void;
  /** Gameplay wallet gate (see `useWalletGate` in GameShell) — only affects the servers/mining tab. */
  hasWallet?: boolean;
  onOpenWalletConnect?: () => void;
  /** Refresh header snapshot after mining check-in rewards. */
  onHeaderRefresh?: () => void | Promise<void>;
  partnerGameSlug?: string | null;
  onOpenPartnerGame?: (slug: string) => void;
  onBackToPartnerHub?: () => void;
};

export function GameViewOutlet({
  view,
  user,
  viewLabel,
  t,
  onNavigate,
  onUsdcChange,
  usdcBalance,
  onSessionRefresh,
  onUserUpdate,
  hasWallet,
  onOpenWalletConnect,
  onHeaderRefresh,
  partnerGameSlug,
  onOpenPartnerGame,
  onBackToPartnerHub
}: GameViewOutletProps) {
  if (view === 'servers') {
    return (
      <MiningPage
        userEmail={user.email}
        onOpenCalculator={() => onNavigate('calculator')}
        onUsdcChange={onUsdcChange}
        onHeaderRefresh={onHeaderRefresh}
        hasWallet={hasWallet !== false}
        onOpenWalletConnect={onOpenWalletConnect}
        isManagingAccount={!!user.isManagingAccount || !!user.managerMode}
      />
    );
  }

  if (view === 'checkin') {
    return <CheckinPage onRewardGranted={onHeaderRefresh} />;
  }

  if (view === 'calculator') {
    return <CalculatorPage onBack={() => onNavigate('servers')} isAdmin={!!user.isAdmin} />;
  }

  if (view === 'transparency') {
    return <TransparencyPage />;
  }

  if (view === 'mini_blog') {
    return (
      <HubPageFrame>
        <MiniBlogPage variant="page" />
      </HubPageFrame>
    );
  }

  if (view === 'quests') {
    return <QuestsPage onGoToRanking={() => onNavigate('ranking')} onUsdcChange={onUsdcChange} />;
  }

  if (view === 'support') {
    return (
      <HubPageFrame compact>
        <SupportPage userEmail={user.email} username={user.username} />
      </HubPageFrame>
    );
  }

  if (view === 'partners') {
    return <PartnersPage />;
  }

  if (view === 'offerwall') {
    return <OfferwallPage />;
  }

  if (view === 'arcade') {
    return <ArcadePage />;
  }

  if (view === 'roleta') {
    return (
      <RoletaPage
        usdcBalance={usdcBalance}
        onUsdcChange={onUsdcChange}
        onReloadGameState={async () => {
          const st = await getWheelState();
          if (st.ok) onUsdcChange(st.data.usdcBalance);
        }}
        onGoToLuckyBoxes={() => onNavigate('lucky_store')}
      />
    );
  }

  if (view === 'inventory') {
    return <InventoryPage />;
  }

  if (view === 'management') {
    return <GerentePage onSessionRefresh={onSessionRefresh} />;
  }

  if (view === 'upgrade') {
    return (
      <UpgradesPage
        usdcBalance={usdcBalance}
        onUsdcChange={onUsdcChange}
        onGoToLuckyBoxes={() => onNavigate('lucky_store')}
        onGoToWallet={() => onNavigate('wallet')}
        user={user}
      />
    );
  }

  if (view === 'merge') {
    return <MergePage usdcBalance={usdcBalance} onUsdcChange={onUsdcChange} />;
  }

  if (view === 'hardware_store') {
    return (
      <ShopPage
        usdcBalance={usdcBalance}
        onUsdcChange={onUsdcChange}
        onGoToWallet={() => onNavigate('wallet')}
        user={user}
      />
    );
  }

  if (view === 'profile') {
    if (user.isManagingAccount) {
      return (
        <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
          <p className="font-sans text-slate-500 dark:text-slate-400">
            {t('shell.profileUnavailable')}
          </p>
          <button
            type="button"
            onClick={() => onNavigate('management')}
            className="rounded-lg border border-amber-500/60 bg-amber-600/20 px-4 py-2 text-sm font-bold text-amber-700 transition hover:bg-amber-600/30 dark:text-amber-200"
          >
            {t('shell.goToManagement')}
          </button>
        </div>
      );
    }
    return <ProfilePage user={user} onUserUpdate={(partial) => onUserUpdate?.(partial)} />;
  }

  if (view === 'black_market') {
    return (
      <BlackMarketPage
        user={{ id: user.id, username: user.username, email: user.email }}
        onUsdcChange={onUsdcChange}
      />
    );
  }

  if (view === 'lucky_store') {
    return (
      <LuckyBoxesPage
        usdcBalance={usdcBalance}
        onUsdcChange={onUsdcChange}
        userEmail={user.email}
        onOpenRoleta={(code) => {
          try {
            sessionStorage.setItem(ROLETA_PREFILL_CODE_SS, code);
          } catch {
            /* ignore */
          }
          onNavigate('roleta');
        }}
      />
    );
  }

  if (view === 'wallet') {
    return (
      <WalletPage
        user={user}
        onUsdcChange={onUsdcChange}
        onUserUpdate={onUserUpdate}
        onNavigate={onNavigate}
      />
    );
  }

  if (view === 'withdrawal_history') {
    return <WithdrawalHistoryPage />;
  }

  if (view === 'deposit_history') {
    return <DepositHistoryPage />;
  }

  if (view === 'ranking') {
    return <RankingPage />;
  }

  if (view === 'dashboard') {
    return <Dashboard onNavigate={(v) => onNavigate(v as GameView)} />;
  }

  if (view === 'partner_games') {
    return (
      <HubPageFrame>
        {partnerGameSlug ? (
          <PartnerGamePlayerPage slug={partnerGameSlug} onBackToHub={onBackToPartnerHub} />
        ) : (
          <PartnerGamesPage onPlayGame={onOpenPartnerGame} />
        )}
      </HubPageFrame>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-amber-500">{t('shell.migrationPending')}</p>
      <h1 className="font-sans text-2xl font-bold text-slate-900 dark:text-white">{viewLabel}</h1>
      <p className="font-sans text-slate-500 dark:text-slate-400">
        {t('shell.pageNotPorted', { view: viewLabel })}
      </p>
    </div>
  );
}
