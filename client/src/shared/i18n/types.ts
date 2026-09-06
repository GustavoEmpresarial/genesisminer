/**
 * Player UI i18n — EN default; pt-BR / es via browser or manual pick.
 * DECISIONS.md #88.
 *
 * Resolution priority (single source of truth):
 * 1. explicit manual preference in localStorage (`genesis.locale` + `genesis.locale.manual`)
 * 2. browser `navigator.languages` / `navigator.language` (+ Intl locale)
 * 3. fallback `en`
 *
 * Auto-detect never overwrites a stored **manual** preference.
 * Orphan `genesis.locale` without the manual flag is ignored (browser wins) so
 * a stuck `en` does not block pt-BR auto-detect.
 */
export type AppLocale = 'en' | 'pt-BR' | 'es';

export const APP_LOCALES: readonly AppLocale[] = ['en', 'pt-BR', 'es'] as const;

export const LOCALE_STORAGE_KEY = 'genesis.locale';
/** Set to `1` only when the user picks a language in the UI. */
export const LOCALE_MANUAL_KEY = 'genesis.locale.manual';

export const DEFAULT_LOCALE: AppLocale = 'en';

export const LOCALE_LABELS: Record<AppLocale, string> = {
  en: 'English',
  'pt-BR': 'Português',
  es: 'Español'
};

/** HTML `lang` attribute for the active locale. */
export function htmlLangFor(locale: AppLocale): string {
  if (locale === 'pt-BR') return 'pt-BR';
  if (locale === 'es') return 'es';
  return 'en';
}

export function isAppLocale(value: unknown): value is AppLocale {
  return value === 'en' || value === 'pt-BR' || value === 'es';
}

/**
 * Normalize any raw tag / alias into a supported `AppLocale`, or `null` if unsupported.
 * Handles: `pt`, `pt-BR`, `pt_BR`, `PT-br`, `en-US`, `es-MX`, whitespace, BCP47 extensions, etc.
 */
export function resolveSupportedLanguage(
  raw: unknown,
  supported: readonly AppLocale[] = APP_LOCALES
): AppLocale | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/_/g, '-');
  const lower = normalized.toLowerCase();

  // Exact (case-insensitive) match against supported codes
  for (const code of supported) {
    if (code.toLowerCase() === lower) return code;
  }

  // Strip Unicode extension / privateuse (pt-BR-u-nu-latn → pt-BR)
  const base = lower.split('-u-')[0]?.split('-x-')[0] ?? lower;
  if (base !== lower) {
    for (const code of supported) {
      if (code.toLowerCase() === base) return code;
    }
  }

  const primary = (base.split('-')[0] ?? '').trim();
  if (!primary) return null;

  // Primary-tag aliases → project locales
  if (primary === 'pt' && supported.includes('pt-BR')) return 'pt-BR';
  if (primary === 'es' && supported.includes('es')) return 'es';
  if (primary === 'en' && supported.includes('en')) return 'en';

  // Region match e.g. pt-br already handled; try code.toLowerCase() === base
  for (const code of supported) {
    if (code.toLowerCase() === base) return code;
  }

  // Any other exact supported primary (future-proof)
  for (const code of supported) {
    if (code.toLowerCase() === primary) return code;
  }

  return null;
}

export function isManualLocalePreference(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(LOCALE_MANUAL_KEY) === '1';
  } catch {
    return false;
  }
}

/** Read + normalize persisted manual preference (or null if absent/invalid/not manual). */
export function readPersistedLocale(): AppLocale | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    if (!isManualLocalePreference()) return null;
    return resolveSupportedLanguage(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function collectBrowserLanguageTags(
  languages?: readonly string[] | null,
  language?: string | null,
  opts?: { includeIntl?: boolean }
): string[] {
  const list: string[] = [];
  const explicit = languages != null || language != null;

  if (languages && languages.length > 0) {
    for (const l of languages) {
      if (l) list.push(String(l));
    }
  }
  if (language) list.push(String(language));

  if (!explicit && typeof navigator !== 'undefined') {
    for (const l of navigator.languages ?? []) {
      if (l) list.push(String(l));
    }
    if (navigator.language) list.push(navigator.language);
  }

  // OS / ICU locale — only when reading the live environment (not test/explicit tags).
  // Helps when navigator.languages is privacy-stripped to en-US.
  const includeIntl = opts?.includeIntl ?? !explicit;
  if (includeIntl) {
    try {
      if (typeof Intl !== 'undefined') {
        const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
        if (intlLocale) list.push(intlLocale);
      }
    } catch {
      /* ignore */
    }
  }

  return list;
}

/**
 * Map browser language list → supported locale (DECISIONS #88).
 * Prefers Portuguese/Spanish tags anywhere in the list (content languages) over bare English,
 * so a browser UI set to English with Portuguese still present resolves to pt-BR.
 *
 * When `languages` / `language` are omitted, reads `navigator` + `Intl` locale.
 */
export function detectBrowserLocale(
  languages?: readonly string[] | null,
  language?: string | null
): AppLocale {
  const list = collectBrowserLanguageTags(languages, language);

  for (const raw of list) {
    const resolved = resolveSupportedLanguage(raw);
    if (resolved === 'pt-BR' || resolved === 'es') return resolved;
  }
  for (const raw of list) {
    const resolved = resolveSupportedLanguage(raw);
    if (resolved) return resolved;
  }
  return DEFAULT_LOCALE;
}

/**
 * Initial locale for the app:
 * manual preference (persisted + flag) → browser detect → `en`.
 * Does **not** turn auto-detect into a sticky preference.
 */
export function resolveInitialLocale(): AppLocale {
  const persisted = readPersistedLocale();
  if (persisted) {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
        if (raw !== persisted) persistLocale(persisted, { manual: true });
      }
    } catch {
      /* ignore */
    }
    return persisted;
  }

  // Drop orphan locale without manual flag so auto-detect can run
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(LOCALE_STORAGE_KEY) != null) {
      if (localStorage.getItem(LOCALE_MANUAL_KEY) !== '1') {
        localStorage.removeItem(LOCALE_STORAGE_KEY);
      }
    }
  } catch {
    /* ignore */
  }

  return detectBrowserLocale();
}

export function persistLocale(locale: AppLocale | string, opts?: { manual?: boolean }): void {
  const resolved = resolveSupportedLanguage(locale) ?? DEFAULT_LOCALE;
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LOCALE_STORAGE_KEY, resolved);
    if (opts?.manual) {
      localStorage.setItem(LOCALE_MANUAL_KEY, '1');
    }
  } catch {
    /* ignore */
  }
}

/** Nested message tree; keys addressed as `a.b.c`. */
export type MessageTree = { [key: string]: string | MessageTree };

export function lookupMessage(tree: MessageTree | undefined, path: string): string | undefined {
  if (!tree) return undefined;
  const parts = path.split('.');
  let cur: string | MessageTree | undefined = tree;
  for (const p of parts) {
    if (cur == null || typeof cur === 'string') return undefined;
    cur = cur[p];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** Replace `{{name}}` placeholders. */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    vars[key] != null ? String(vars[key]) : `{{${key}}}`
  );
}

/** Pure translate against a catalog map (used by provider + tests). */
export function translateWithCatalogs(
  catalogs: Record<AppLocale, MessageTree>,
  locale: AppLocale,
  key: string,
  vars?: Record<string, string | number>
): string {
  const safe = resolveSupportedLanguage(locale) ?? DEFAULT_LOCALE;
  const primary = lookupMessage(catalogs[safe], key);
  const fallback = safe === 'en' ? undefined : lookupMessage(catalogs.en, key);
  const template = primary ?? fallback ?? key;
  return interpolate(template, vars);
}
