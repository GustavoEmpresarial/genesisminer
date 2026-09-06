import { BookOpen, LogOut, Trophy, User as UserIcon, X } from 'lucide-react';
import { DISCORD_COMMUNITY_URL, TELEGRAM_COMMUNITY_URL } from '../../../shared/constants/communityLinks';
import { DiscordIcon, TelegramIcon } from '../../../shared/icons/SocialBrandIcons';
import { LanguageSwitcher, useT } from '../../../shared/i18n';
import type { User } from '../../../shared/types/auth';
import {
  GAME_NAV_SECTION_ORDER,
  getGameNavSectionLabels,
  gameNavTabClass,
  type GameNavItem,
  type GameView
} from '../nav/buildGameNavItems';
import { GAME_NAV_LABEL_KEYS, type GameNavLabelKey } from '../../../shared/constants/gameNavLabels';

type GameMobileDrawerProps = {
  open: boolean;
  user: User;
  items: GameNavItem[];
  currentView: GameView;
  onClose: () => void;
  onNavigate: (view: GameView) => void;
  onDocs: () => void;
  onAdmin?: () => void;
  onLogout: () => void;
};

function navItemLabel(key: GameView, fallback: string, t: (key: string) => string): string {
  if ((GAME_NAV_LABEL_KEYS as readonly string[]).includes(key)) {
    return t(`nav.${key as GameNavLabelKey}`);
  }
  if (key === 'profile') return t('nav.profile');
  if (key === 'management') return t('nav.management');
  if (key === 'merge') return t('nav.merge');
  if (key === 'calculator') return t('nav.calculator');
  if (key === 'dashboard') return t('nav.dashboard');
  return fallback;
}

export function GameMobileDrawer({
  open,
  user,
  items,
  currentView,
  onClose,
  onNavigate,
  onDocs,
  onAdmin,
  onLogout
}: GameMobileDrawerProps) {
  const t = useT();
  const sectionLabels = getGameNavSectionLabels(t);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] lg:hidden">
      <button type="button" aria-label={t('shell.closeMenu')} onClick={onClose} className="absolute inset-0 bg-slate-950/72 backdrop-blur-[2px]" />
      <aside className="absolute inset-y-0 left-0 flex w-[84vw] max-w-[320px] flex-col border-r border-amber-500/20 bg-gradient-to-b from-[#0b1224] via-[#0b1020] to-[#080d18] shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
        <div className="flex items-center justify-between border-b border-slate-800/90 px-4 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-slate-900 shadow-lg shadow-amber-600/25 ring-2 ring-amber-500/50">
              <img
                src="/img/favicon/genesis-miner-logo.webp"
                onError={(e) => {
                  e.currentTarget.onerror = null;
                  e.currentTarget.src = '/genesis-miner-logo.png';
                }}
                alt=""
                className="h-full w-full object-cover"
                width={40}
                height={40}
                aria-hidden
              />
            </div>
            <div className="min-w-0 text-left">
              <div className="truncate bg-gradient-to-r from-amber-400 to-orange-400 bg-clip-text text-lg font-bold text-transparent">
                {t('landing.brand')}
              </div>
              <div className="block truncate bg-gradient-to-r from-amber-400 to-orange-400 bg-clip-text text-[9px] font-semibold tracking-wider text-transparent">
                {t('common.tagline')}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 bg-slate-900/80 p-2 text-slate-300 transition hover:border-amber-500/40 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4 [scrollbar-width:thin]">
          <div className="mb-4 space-y-3 border-b border-slate-800/90 pb-4">
            {GAME_NAV_SECTION_ORDER.map((section) => {
              const sectionItems = items.filter((item) => item.section === section);
              if (sectionItems.length === 0) return null;
              return (
                <div key={section} className="space-y-2">
                  <div className="px-1 text-[10px] font-black uppercase tracking-[0.2em] text-amber-400/80">
                    {sectionLabels[section]}
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {sectionItems.map((item) => {
                      const Icon = item.icon;
                      const label = navItemLabel(item.key, item.label, t);
                      return (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => {
                            onNavigate(item.key);
                            onClose();
                          }}
                          className={`${gameNavTabClass(currentView === item.key, item.accent)} w-full justify-start`}
                          title={label}
                        >
                          <Icon size={16} className="shrink-0 opacity-90" />
                          <span className="truncate uppercase">{label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="space-y-2">
            <a
              href={DISCORD_COMMUNITY_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onClose}
              className="flex w-full items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-3 text-sm font-bold text-[#7289da] transition hover:border-[#5865F2]/40 hover:bg-[#5865F2]/10"
            >
              <DiscordIcon size={17} /> Discord
            </a>
            <a
              href={TELEGRAM_COMMUNITY_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onClose}
              className="flex w-full items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-3 text-sm font-bold text-[#26A5E4] transition hover:border-[#229ED9]/40 hover:bg-[#229ED9]/10"
            >
              <TelegramIcon size={17} /> Telegram
            </a>
            <button
              type="button"
              onClick={() => {
                onNavigate('ranking');
                onClose();
              }}
              className="flex w-full items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-3 text-left text-sm font-bold text-yellow-400 transition hover:border-slate-600 hover:bg-slate-800/90"
            >
              <Trophy size={17} /> {t('shell.rankingShort')}
            </button>
            <button
              type="button"
              onClick={() => {
                onDocs();
                onClose();
              }}
              className="flex w-full items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-3 text-left text-sm font-bold text-slate-200 transition hover:border-slate-600 hover:bg-slate-800/90"
            >
              <BookOpen size={17} /> {t('common.docs')}
            </button>
            <LanguageSwitcher className="px-3 py-2" />
            <button
              type="button"
              onClick={() => {
                onNavigate('profile');
                onClose();
              }}
              className="flex w-full items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-3 text-left text-sm font-bold text-slate-200 transition hover:border-slate-600 hover:bg-slate-800/90"
            >
              <UserIcon size={17} /> {user.username}
            </button>
            {(user.isAdmin || user.isImpersonating) && onAdmin && (
              <button
                type="button"
                onClick={() => {
                  onAdmin();
                  onClose();
                }}
                className="flex w-full items-center gap-3 rounded-xl border border-red-900/50 bg-red-950/40 px-3 py-3 text-left text-sm font-bold text-red-400"
              >
                {t('shell.adminPanel')}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onLogout();
                onClose();
              }}
              className="flex w-full items-center gap-3 rounded-xl border border-red-900/50 bg-red-950/40 px-3 py-3 text-left text-sm font-bold text-red-400"
            >
              <LogOut size={17} /> {t('shell.logout')}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
