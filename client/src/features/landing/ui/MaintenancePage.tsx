import React from 'react';
import { User, Wrench } from 'lucide-react';
import { DISCORD_COMMUNITY_URL, TELEGRAM_COMMUNITY_URL } from '../../../shared/constants/communityLinks';
import { DiscordIcon, TelegramIcon } from '../../../shared/icons/SocialBrandIcons';
import { LanguageSwitcher, useT } from '../../../shared/i18n';
import { TopIdleVerificationMark } from '../../../shared/seo/TopIdleVerificationMark';

type Props = {
  onAdminLogin?: () => void;
  showLogin?: boolean;
};

export const MaintenancePage: React.FC<Props> = ({ onAdminLogin, showLogin }) => {
  const t = useT();

  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-slate-50 text-slate-800 transition-colors dark:bg-[#120e09] dark:text-slate-200">
      <TopIdleVerificationMark />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.07] dark:opacity-[0.12]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(0,0,0,0.04) 2px, rgba(0,0,0,0.04) 4px)'
        }}
        aria-hidden
      />
      <div className="pointer-events-none absolute right-0 top-0 -mr-24 -mt-24 h-[28rem] w-[28rem] rounded-full bg-amber-500/[0.12] blur-3xl dark:bg-amber-400/15" aria-hidden />
      <div className="pointer-events-none absolute bottom-0 left-0 -mb-24 -ml-24 h-[28rem] w-[28rem] rounded-full bg-orange-600/[0.1] blur-3xl dark:bg-orange-500/15" aria-hidden />
      <div className="pointer-events-none absolute left-0 top-1/4 hidden h-48 w-1 rounded-r-full bg-gradient-to-b from-amber-400 via-amber-500 to-orange-600 opacity-90 sm:block md:h-64" aria-hidden />

      <header className="relative z-10 flex items-center justify-end px-4 py-3 sm:px-6">
        <LanguageSwitcher />
      </header>

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
        <img
          src="/img/favicon/genesis-miner-logo.webp"
          alt=""
          className="h-16 w-16 rounded-2xl border border-amber-200/70 bg-white p-1.5 shadow-lg shadow-amber-600/20 dark:border-amber-900/50 dark:bg-slate-900"
        />

        <div className="mt-8 inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-500/10 px-4 py-1.5 text-[11px] font-black uppercase tracking-[0.2em] text-amber-700 shadow-[0_0_24px_rgba(251,191,36,0.2)] dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-300">
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400 shadow-[0_0_10px_#fbbf24]" />
          {t('common.maintenanceBadge')}
        </div>

        <h1 className="mt-6 max-w-xl text-4xl font-black tracking-tight text-slate-900 dark:text-white sm:text-5xl">
          {t('common.maintenanceTitle')}
        </h1>
        <p className="mt-4 max-w-md text-base leading-relaxed text-slate-600 dark:text-slate-400 sm:text-lg">
          {t('common.maintenanceBody')}
        </p>

        <div className="mt-8 flex items-center justify-center gap-3 text-slate-500 dark:text-slate-400">
          <Wrench size={16} className="opacity-70" aria-hidden />
          <p className="text-xs font-semibold uppercase tracking-[0.18em]">{t('landing.brand')}</p>
        </div>

        <div className="mt-8 flex items-center gap-2">
          <a
            href={DISCORD_COMMUNITY_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg p-2.5 text-slate-500 transition hover:bg-slate-200 hover:text-[#7289da] dark:hover:bg-slate-800"
            title="Discord"
          >
            <DiscordIcon size={20} />
          </a>
          <a
            href={TELEGRAM_COMMUNITY_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg p-2.5 text-slate-500 transition hover:bg-slate-200 hover:text-[#26A5E4] dark:hover:bg-slate-800"
            title="Telegram"
          >
            <TelegramIcon size={20} />
          </a>
        </div>

        {showLogin && onAdminLogin ? (
          <button
            type="button"
            onClick={onAdminLogin}
            className="mt-10 inline-flex items-center gap-2 rounded-lg border border-amber-300/40 bg-gradient-to-r from-amber-400 to-amber-600 px-4 py-2.5 text-sm font-bold text-stone-950 shadow-lg shadow-amber-600/30 transition hover:from-amber-300 hover:to-amber-500"
          >
            <User size={16} />
            {t('common.login')}
          </button>
        ) : null}
        {showLogin ? (
          <p className="mt-3 max-w-sm text-xs text-slate-500 dark:text-slate-500">{t('common.maintenanceAdminHint')}</p>
        ) : null}
      </main>
    </div>
  );
};
