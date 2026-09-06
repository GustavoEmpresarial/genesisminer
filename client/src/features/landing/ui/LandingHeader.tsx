import { BookOpen, Headphones, User } from 'lucide-react';
import { DISCORD_COMMUNITY_URL, TELEGRAM_COMMUNITY_URL } from '../../../shared/constants/communityLinks';
import { DiscordIcon, TelegramIcon } from '../../../shared/icons/SocialBrandIcons';
import { LanguageSwitcher, useT } from '../../../shared/i18n';

type LandingHeaderProps = {
  onLogin: () => void;
  onHome: () => void;
  onDocs?: () => void;
  onSupport?: () => void;
};

/** Header público — mesmo visual do legado na home. */
export function LandingHeader({ onLogin, onHome, onDocs, onSupport }: LandingHeaderProps) {
  const t = useT();

  return (
    <header className="z-50 shrink-0 border-b border-slate-200 bg-white/90 shadow-sm backdrop-blur-md transition-colors duration-300 dark:border-amber-900/30 dark:bg-slate-900/90">
      <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col justify-between gap-2 px-3 py-2 sm:px-4 md:flex-row md:items-center md:gap-3 md:py-2.5">
        <button type="button" onClick={onHome} className="flex min-w-0 items-center gap-3 text-left" aria-label={t('common.homeAria')}>
          <img
            src="/img/favicon/genesis-miner-logo.webp"
            alt=""
            className="h-10 w-10 rounded-xl border border-amber-200/70 bg-white p-1 shadow-sm dark:border-amber-900/50 dark:bg-slate-900"
          />
          <div className="min-w-0">
            <p className="bg-gradient-to-r from-amber-500 to-orange-600 bg-clip-text text-xs font-semibold uppercase tracking-widest text-transparent dark:from-amber-300 dark:to-amber-500">
              {t('landing.brand')}
            </p>
            <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">{t('common.tagline')}</p>
          </div>
        </button>

        <div className="flex flex-wrap items-center gap-1.5 self-end md:self-auto">
          <a
            href={DISCORD_COMMUNITY_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded p-2 text-slate-500 transition hover:bg-slate-200 hover:text-[#7289da] dark:hover:bg-slate-800"
            title="Discord"
          >
            <DiscordIcon size={18} />
          </a>
          <a
            href={TELEGRAM_COMMUNITY_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded p-2 text-slate-500 transition hover:bg-slate-200 hover:text-[#26A5E4] dark:hover:bg-slate-800"
            title="Telegram"
          >
            <TelegramIcon size={18} />
          </a>
          <button
            type="button"
            onClick={() => onDocs?.()}
            className="rounded p-2 text-slate-500 transition hover:bg-slate-200 dark:hover:bg-slate-800"
            title={t('common.docs')}
          >
            <BookOpen size={18} />
          </button>
          <button
            type="button"
            onClick={() => onSupport?.()}
            className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 transition hover:border-amber-400 hover:text-amber-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 sm:px-3 sm:text-sm"
            title="Suporte"
          >
            <Headphones size={16} />
            <span>Suporte</span>
          </button>
          <LanguageSwitcher />
          <button
            type="button"
            onClick={onLogin}
            className="flex items-center gap-2 rounded border border-amber-300/40 bg-gradient-to-r from-amber-400 to-amber-600 px-3 py-2 text-sm font-bold text-stone-950 shadow-lg shadow-amber-600/30 transition hover:from-amber-300 hover:to-amber-500 sm:px-4"
          >
            <User size={16} /> {t('common.login')}
          </button>
        </div>
      </div>
    </header>
  );
}
