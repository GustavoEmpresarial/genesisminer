import type { ReactNode } from 'react';
import { AlertCircle, ArrowLeft, CheckCircle2 } from 'lucide-react';
import { useT } from '../../i18n';

type AuthShellProps = {
  title: string;
  subtitle: string;
  children: ReactNode;
  error?: string | null;
  successMessage?: string | null;
  tabs?: ReactNode;
};

/** Layout comum das páginas de auth (banner ZerAds + card). */
export function AuthShell({ title, subtitle, children, error, successMessage, tabs }: AuthShellProps) {
  const t = useT();

  return (
    <div className="flex min-h-[80vh] flex-col items-center justify-center px-4 py-10 animate-in fade-in zoom-in-95 duration-300">
      <div className="mb-6 flex w-full justify-center">
        <iframe
          src="https://zerads.com/ad/ad.php?width=728&ref=11294"
          width={728}
          height={90}
          marginWidth={0}
          marginHeight={0}
          frameBorder={0}
          scrolling="no"
          title="ZerAds banner"
          style={{ maxWidth: '100%', border: 0, display: 'block' }}
        />
      </div>
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl transition-colors dark:border-slate-800 dark:bg-slate-900">
        <div className="p-8">
          <div className="mb-6 flex flex-wrap items-center gap-2">
            <a
              href="/"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 text-sm font-semibold leading-none text-slate-700 transition-colors hover:border-amber-500/50 hover:text-amber-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200 dark:hover:text-amber-400"
            >
              <ArrowLeft size={16} className="shrink-0" aria-hidden />
              {t('auth.backToHome')}
            </a>
            <a
              href="/support"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-amber-300/50 bg-amber-50 px-4 text-sm font-semibold leading-none text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
            >
              {t('nav.support')}
            </a>
          </div>

          <div className="mb-8 text-center">
            <h2 className="mb-2 text-2xl font-bold text-slate-900 dark:text-white">{title}</h2>
            <p className="text-sm text-slate-500">{subtitle}</p>
          </div>

          {tabs}

          {successMessage && !error && (
            <div className="mb-6 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-400">
              <CheckCircle2 size={16} /> {successMessage}
            </div>
          )}
          {error && (
            <div className="mb-6 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-400">
              <AlertCircle size={16} /> {error}
            </div>
          )}

          {children}
        </div>
      </div>
    </div>
  );
}

type AuthModeTabsProps = {
  active: 'login' | 'register';
  onLogin: () => void;
  onRegister: () => void;
};

export function AuthModeTabs({ active, onLogin, onRegister }: AuthModeTabsProps) {
  const t = useT();
  return (
    <div className="mb-6 flex rounded-lg bg-slate-100 p-1 dark:bg-slate-950">
      <button
        type="button"
        onClick={onLogin}
        className={`flex-1 rounded py-2 text-xs font-bold uppercase ${
          active === 'login' ? 'bg-white text-amber-600 shadow dark:bg-slate-800' : 'text-slate-500'
        }`}
      >
        {t('auth.tabLogin')}
      </button>
      <button
        type="button"
        onClick={onRegister}
        className={`flex-1 rounded py-2 text-xs font-bold uppercase ${
          active === 'register' ? 'bg-white text-amber-600 shadow dark:bg-slate-800' : 'text-slate-500'
        }`}
      >
        {t('auth.tabRegister')}
      </button>
    </div>
  );
}
