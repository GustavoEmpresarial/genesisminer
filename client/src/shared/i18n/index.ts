export type { AppLocale, MessageTree } from './types';
export {
  APP_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  LOCALE_MANUAL_KEY,
  LOCALE_STORAGE_KEY,
  detectBrowserLocale,
  htmlLangFor,
  isAppLocale,
  isManualLocalePreference,
  persistLocale,
  readPersistedLocale,
  resolveInitialLocale,
  resolveSupportedLanguage,
  translateWithCatalogs
} from './types';
export { I18nProvider, useI18n, useT, tForLocale, getI18nCatalogs } from './I18nProvider';
export type { TranslateFn } from './I18nProvider';
export { LanguageSwitcher } from './LanguageSwitcher';
