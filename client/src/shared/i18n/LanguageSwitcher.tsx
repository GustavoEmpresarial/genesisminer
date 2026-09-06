import { Languages } from 'lucide-react';
import { APP_LOCALES, LOCALE_LABELS, resolveSupportedLanguage, type AppLocale } from './types';
import { useI18n } from './I18nProvider';

type LanguageSwitcherProps = {
  /** Compact select for headers; default fits landing + game chrome. */
  className?: string;
};

/**
 * Locale select — value always mirrors `I18nProvider` locale (single source of truth).
 * onChange → normalize → setLocale (persists + re-renders via context).
 */
export function LanguageSwitcher({ className = '' }: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useI18n();

  return (
    <label
      className={`inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400 ${className}`}
      title={t('common.language')}
    >
      <Languages size={16} className="shrink-0 opacity-80" aria-hidden />
      <span className="sr-only">{t('common.language')}</span>
      <select
        value={locale}
        onChange={(e) => {
          const next = resolveSupportedLanguage(e.target.value);
          if (next) setLocale(next);
        }}
        className="max-w-[7.5rem] cursor-pointer rounded border border-slate-200 bg-white/90 py-1 pl-1.5 pr-1 text-[11px] font-semibold text-slate-700 outline-none hover:border-amber-400/50 focus:border-amber-500 dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-200"
        aria-label={t('common.language')}
      >
        {APP_LOCALES.map((code: AppLocale) => (
          <option key={code} value={code}>
            {LOCALE_LABELS[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
