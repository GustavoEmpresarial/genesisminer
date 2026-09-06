/**
 * Chrome admin pós-login: top nav (sem strip de jogo) + AdminPanel.
 * Layout: viewport fixo — sidebar não scrolla com o corpo (só a coluna direita).
 */
import { BookOpen, LogOut, Play } from 'lucide-react';
import type { User } from '../../../shared/types/auth';
import {
  DiscordCommunityLink,
  TelegramCommunityLink
} from '../../../shared/icons/SocialBrandIcons';
import { LanguageSwitcher, useT } from '../../../shared/i18n';
import { AdminPanel } from './AdminPanel';

type AdminShellProps = {
  user: User;
  onLogout: () => void;
  onOpenGame: () => void;
  onDocs: () => void;
};

export function AdminShell({ user, onLogout, onOpenGame, onDocs }: AdminShellProps) {
  const t = useT();

  return (
    <div className="flex h-[100dvh] min-h-0 w-full flex-col overflow-hidden bg-slate-50 font-sans text-slate-800 transition-colors duration-300 dark:bg-[#0f0c08] dark:text-slate-200">
      <a
        href="#main-content"
        className="fixed left-4 top-0 z-[9999] -translate-y-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-stone-950 shadow-lg outline-none ring-2 ring-amber-200 transition focus:translate-y-4 focus:ring-offset-2 focus:ring-offset-[#0f0c08]"
      >
        {t('shell.skipToMain')}
      </a>

      <header className="z-50 shrink-0 border-b border-slate-200 bg-white/90 shadow-sm backdrop-blur-md transition-colors duration-300 dark:border-amber-900/30 dark:bg-slate-900/90">
        <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col justify-between gap-2 px-3 py-2 sm:px-4 md:flex-row md:items-center md:gap-3 md:py-2.5">
          <button type="button" onClick={onOpenGame} className="flex min-w-0 items-center gap-3 text-left">
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-slate-900 shadow-lg shadow-amber-600/25 ring-2 ring-amber-500/50">
              <img
                src="/img/favicon/genesis-miner-logo.webp"
                alt=""
                className="h-full w-full object-cover"
                width={40}
                height={40}
                aria-hidden
              />
            </div>
            <div className="min-w-0 text-left">
              <p className="truncate bg-gradient-to-r from-amber-600 to-orange-600 bg-clip-text text-xl font-bold text-transparent dark:from-amber-400 dark:to-orange-400">
                {t('landing.brand')}
              </p>
              <span className="block truncate bg-gradient-to-r from-amber-600 to-orange-600 bg-clip-text text-[10px] font-semibold tracking-wider text-transparent dark:from-amber-400 dark:to-orange-400">
                Ecossistema online V0.5 — Genesis DAO
              </span>
            </div>
          </button>

          <div className="flex items-center gap-1.5 self-end md:self-auto">
            <DiscordCommunityLink size={18} />
            <TelegramCommunityLink size={18} />
            <button
              type="button"
              onClick={onDocs}
              className="rounded px-3 py-2 text-sm font-bold text-slate-500 transition hover:bg-slate-200 dark:hover:bg-slate-800"
              title={t('common.docs')}
            >
              <BookOpen size={18} />
            </button>
            <LanguageSwitcher />
            <button
              type="button"
              onClick={onOpenGame}
              className="rounded px-3 py-2 text-sm font-bold text-amber-600 transition hover:bg-slate-200 dark:text-amber-400 dark:hover:bg-slate-800"
              title="Voltar ao Jogo"
            >
              <Play size={18} fill="currentColor" />
            </button>
            <div className="ml-2 text-right">
              <div className="text-xs uppercase text-slate-500">{t('shell.administrator')}</div>
              <div className="text-sm font-bold text-red-500">{user.username}</div>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="rounded border border-red-200 bg-red-100 p-2 text-red-600 transition hover:bg-red-200 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40"
              title={t('shell.logout')}
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <AdminPanel user={user} />
      </div>
    </div>
  );
}
