/**
 * Player i18n — locale resolution, persistence priority, catalog translate.
 * Imports pure helpers from `client/src/shared/i18n` (no React).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../../client/src/shared/i18n/locales/en.js';
import { es } from '../../../client/src/shared/i18n/locales/es.js';
import { ptBR } from '../../../client/src/shared/i18n/locales/pt-BR.js';
import {
  DEFAULT_LOCALE,
  LOCALE_MANUAL_KEY,
  LOCALE_STORAGE_KEY,
  detectBrowserLocale,
  persistLocale,
  readPersistedLocale,
  resolveInitialLocale,
  resolveSupportedLanguage,
  translateWithCatalogs,
  type AppLocale,
  type MessageTree
} from '../../../client/src/shared/i18n/types.js';

const CATALOGS: Record<AppLocale, MessageTree> = {
  en,
  'pt-BR': ptBR,
  es
};

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null
  };
  vi.stubGlobal('localStorage', ls);
  return store;
}

describe('resolveSupportedLanguage', () => {
  it('maps regional / alias codes to supported locales', () => {
    expect(resolveSupportedLanguage('pt-BR')).toBe('pt-BR');
    expect(resolveSupportedLanguage('pt')).toBe('pt-BR');
    expect(resolveSupportedLanguage('pt_BR')).toBe('pt-BR');
    expect(resolveSupportedLanguage('PT-br')).toBe('pt-BR');
    expect(resolveSupportedLanguage('pt-PT')).toBe('pt-BR');
    expect(resolveSupportedLanguage('pt-BR-u-nu-latn')).toBe('pt-BR');
    expect(resolveSupportedLanguage('en')).toBe('en');
    expect(resolveSupportedLanguage('en-US')).toBe('en');
    expect(resolveSupportedLanguage('en_GB')).toBe('en');
    expect(resolveSupportedLanguage('es')).toBe('es');
    expect(resolveSupportedLanguage('es-ES')).toBe('es');
    expect(resolveSupportedLanguage('es-MX')).toBe('es');
  });

  it('rejects unsupported / empty codes', () => {
    expect(resolveSupportedLanguage('zh-CN')).toBeNull();
    expect(resolveSupportedLanguage('fr')).toBeNull();
    expect(resolveSupportedLanguage('')).toBeNull();
    expect(resolveSupportedLanguage(null)).toBeNull();
    expect(resolveSupportedLanguage('   ')).toBeNull();
  });
});

describe('detectBrowserLocale', () => {
  it('pt-BR browser → pt-BR', () => {
    expect(detectBrowserLocale(['pt-BR'], 'pt-BR')).toBe('pt-BR');
  });

  it('en-US only → en', () => {
    expect(detectBrowserLocale(['en-US', 'en'], 'en-US')).toBe('en');
  });

  it('es-MX → es', () => {
    expect(detectBrowserLocale(['es-MX'], 'es-MX')).toBe('es');
  });

  it('prefers pt/es over earlier en* (DECISIONS #88)', () => {
    expect(detectBrowserLocale(['en-US', 'en', 'pt-BR', 'pt'], 'en-US')).toBe('pt-BR');
    expect(detectBrowserLocale(['en', 'es-ES'], 'en')).toBe('es');
  });

  it('unsupported only → fallback en', () => {
    expect(detectBrowserLocale(['zh-CN', 'fr-FR'], 'zh-CN')).toBe(DEFAULT_LOCALE);
  });
});

describe('resolveInitialLocale priority', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { languages: ['en-US'], language: 'en-US' }
    });
    // Pin Intl so CI/dev machines with pt OS do not skew live-env detection tests
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'en-US'
    } as Intl.ResolvedDateTimeFormatOptions);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('without preference: uses browser languages', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { languages: ['en-US', 'en'], language: 'en-US' }
    });
    expect(resolveInitialLocale()).toBe('en');

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { languages: ['pt-BR'], language: 'pt-BR' }
    });
    expect(resolveInitialLocale()).toBe('pt-BR');
  });

  it('orphan genesis.locale=en without manual flag → browser pt-BR wins', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { languages: ['pt-BR'], language: 'pt-BR' }
    });
    expect(resolveInitialLocale()).toBe('pt-BR');
    expect(readPersistedLocale()).toBeNull();
  });

  it('manual preference en wins over browser pt-BR', () => {
    persistLocale('en', { manual: true });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { languages: ['pt-BR'], language: 'pt-BR' }
    });
    expect(resolveInitialLocale()).toBe('en');
    expect(readPersistedLocale()).toBe('en');
    expect(localStorage.getItem(LOCALE_MANUAL_KEY)).toBe('1');
  });

  it('normalizes legacy stored aliases only when manual', () => {
    persistLocale('pt', { manual: true });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { languages: ['en-US'], language: 'en-US' }
    });
    expect(resolveInitialLocale()).toBe('pt-BR');

    persistLocale('pt_BR', { manual: true });
    expect(resolveInitialLocale()).toBe('pt-BR');
  });

  it('invalid stored value falls through to browser detect', () => {
    localStorage.setItem(LOCALE_MANUAL_KEY, '1');
    localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { languages: ['es-AR'], language: 'es-AR' }
    });
    expect(resolveInitialLocale()).toBe('es');
  });

  it('manual switch persist + reload simulation', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { languages: ['pt-BR'], language: 'pt-BR' }
    });
    expect(resolveInitialLocale()).toBe('pt-BR');

    persistLocale('en', { manual: true });
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    expect(resolveInitialLocale()).toBe('en'); // auto must not override
  });

  it('Intl pt-BR with en navigator → pt-BR (live env)', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { languages: ['en-US'], language: 'en-US' }
    });
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'pt-BR'
    } as Intl.ResolvedDateTimeFormatOptions);
    expect(resolveInitialLocale()).toBe('pt-BR');
  });
});

describe('translateWithCatalogs (multi-feature keys)', () => {
  it('landing + nav + common change across locales', () => {
    expect(translateWithCatalogs(CATALOGS, 'en', 'landing.heroTitle1')).toBe('OPERATE WITH STRATEGY');
    expect(translateWithCatalogs(CATALOGS, 'pt-BR', 'landing.heroTitle1')).toBe('OPERE COM ESTRATÉGIA');
    expect(translateWithCatalogs(CATALOGS, 'es', 'landing.heroTitle1')).toBe('OPERA CON ESTRATEGIA');

    expect(translateWithCatalogs(CATALOGS, 'en', 'nav.servers')).toBe('Mining');
    expect(translateWithCatalogs(CATALOGS, 'pt-BR', 'nav.servers')).toBe('Mineração');
    expect(translateWithCatalogs(CATALOGS, 'es', 'nav.servers')).toBe('Minería');

    expect(translateWithCatalogs(CATALOGS, 'en', 'common.language')).toBe('Language');
    expect(translateWithCatalogs(CATALOGS, 'pt-BR', 'common.language')).toBe('Idioma');
    expect(translateWithCatalogs(CATALOGS, 'es', 'common.language')).toBe('Idioma');
  });

  it('missing key falls back to en then key', () => {
    expect(translateWithCatalogs(CATALOGS, 'pt-BR', 'common.login')).toBe('ENTRAR');
    expect(translateWithCatalogs(CATALOGS, 'pt-BR', 'zzz.does.not.exist')).toBe('zzz.does.not.exist');
  });

  it('interpolates vars', () => {
    const enMsg = translateWithCatalogs(CATALOGS, 'en', 'landing.heroBody', {
      brand: 'X',
      tokenomics: 'Y'
    });
    expect(enMsg).toContain('X');
    expect(enMsg).toContain('Y');
  });
});
