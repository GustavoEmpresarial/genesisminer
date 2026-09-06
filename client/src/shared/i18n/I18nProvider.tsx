import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import { en } from './locales/en';
import { es } from './locales/es';
import { ptBR } from './locales/pt-BR';
import { walletEn, walletEs, walletPt } from './locales/features/wallet';
import { shopEn, shopEs, shopPt } from './locales/features/shop';
import { inventoryEn, inventoryEs, inventoryPt } from './locales/features/inventory';
import { wheelEn, wheelEs, wheelPt } from './locales/features/wheel';
import { mergeEn, mergeEs, mergePt } from './locales/features/merge';
import { luckyBoxesEn, luckyBoxesEs, luckyBoxesPt } from './locales/features/luckyBoxes';
import { blackMarketEn, blackMarketEs, blackMarketPt } from './locales/features/blackMarket';
import { profileEn, profileEs, profilePt } from './locales/features/profile';
import { serversEn, serversEs, serversPt } from './locales/features/servers';
import { rankingEn, rankingEs, rankingPt } from './locales/features/ranking';
import { partnerGamesEn, partnerGamesEs, partnerGamesPt } from './locales/features/partnerGames';
import { roadmapEn, roadmapEs, roadmapPt } from './locales/features/roadmap';
import { calculatorEn, calculatorEs, calculatorPt } from './locales/features/calculator';
import {
  DEFAULT_LOCALE,
  htmlLangFor,
  persistLocale,
  resolveInitialLocale,
  resolveSupportedLanguage,
  translateWithCatalogs,
  type AppLocale,
  type MessageTree
} from './types';

function mergeCatalog(base: MessageTree, features: Record<string, MessageTree>): MessageTree {
  return { ...base, ...features };
}

const CATALOGS: Record<AppLocale, MessageTree> = {
  en: mergeCatalog(en, {
    wallet: walletEn,
    shop: shopEn,
    inventory: inventoryEn,
    wheel: wheelEn,
    merge: mergeEn,
    luckyBoxes: luckyBoxesEn,
    blackMarket: blackMarketEn,
    profile: profileEn,
    servers: serversEn,
    ranking: rankingEn,
    partnerGames: partnerGamesEn,
    roadmap: roadmapEn,
    calculator: calculatorEn
  }),
  'pt-BR': mergeCatalog(ptBR, {
    wallet: walletPt,
    shop: shopPt,
    inventory: inventoryPt,
    wheel: wheelPt,
    merge: mergePt,
    luckyBoxes: luckyBoxesPt,
    blackMarket: blackMarketPt,
    profile: profilePt,
    servers: serversPt,
    ranking: rankingPt,
    partnerGames: partnerGamesPt,
    roadmap: roadmapPt,
    calculator: calculatorPt
  }),
  es: mergeCatalog(es, {
    wallet: walletEs,
    shop: shopEs,
    inventory: inventoryEs,
    wheel: wheelEs,
    merge: mergeEs,
    luckyBoxes: luckyBoxesEs,
    blackMarket: blackMarketEs,
    profile: profileEs,
    servers: serversEs,
    ranking: rankingEs,
    partnerGames: partnerGamesEs,
    roadmap: roadmapEs,
    calculator: calculatorEs
  })
};

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

type I18nContextValue = {
  locale: AppLocale;
  setLocale: (locale: AppLocale | string) => void;
  t: TranslateFn;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function translate(locale: AppLocale, key: string, vars?: Record<string, string | number>): string {
  return translateWithCatalogs(CATALOGS, locale, key, vars);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(() => resolveInitialLocale());

  const setLocale = useCallback((next: AppLocale | string) => {
    const resolved = resolveSupportedLanguage(next) ?? DEFAULT_LOCALE;
    setLocaleState(resolved);
    persistLocale(resolved, { manual: true });
  }, []);

  useLayoutEffect(() => {
    document.documentElement.lang = htmlLangFor(locale);
  }, [locale]);

  const t = useCallback<TranslateFn>((key, vars) => translate(locale, key, vars), [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}

export function useT(): TranslateFn {
  return useI18n().t;
}

export function tForLocale(locale: AppLocale, key: string, vars?: Record<string, string | number>): string {
  return translate(locale, key, vars);
}

/** Exported for catalog parity tests. */
export function getI18nCatalogs(): Record<AppLocale, MessageTree> {
  return CATALOGS;
}
