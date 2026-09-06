/**
 * Feature i18n catalogs — key parity across en / pt-BR / es + interpolation + locale switch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../../client/src/shared/i18n/locales/en.js';
import { es } from '../../../client/src/shared/i18n/locales/es.js';
import { ptBR } from '../../../client/src/shared/i18n/locales/pt-BR.js';
import { walletEn, walletEs, walletPt } from '../../../client/src/shared/i18n/locales/features/wallet.js';
import { shopEn, shopEs, shopPt } from '../../../client/src/shared/i18n/locales/features/shop.js';
import { inventoryEn, inventoryEs, inventoryPt } from '../../../client/src/shared/i18n/locales/features/inventory.js';
import { wheelEn, wheelEs, wheelPt } from '../../../client/src/shared/i18n/locales/features/wheel.js';
import { mergeEn, mergeEs, mergePt } from '../../../client/src/shared/i18n/locales/features/merge.js';
import { luckyBoxesEn, luckyBoxesEs, luckyBoxesPt } from '../../../client/src/shared/i18n/locales/features/luckyBoxes.js';
import { blackMarketEn, blackMarketEs, blackMarketPt } from '../../../client/src/shared/i18n/locales/features/blackMarket.js';
import { profileEn, profileEs, profilePt } from '../../../client/src/shared/i18n/locales/features/profile.js';
import { serversEn, serversEs, serversPt } from '../../../client/src/shared/i18n/locales/features/servers.js';
import { rankingEn, rankingEs, rankingPt } from '../../../client/src/shared/i18n/locales/features/ranking.js';
import { partnerGamesEn, partnerGamesEs, partnerGamesPt } from '../../../client/src/shared/i18n/locales/features/partnerGames.js';
import { roadmapEn, roadmapEs, roadmapPt } from '../../../client/src/shared/i18n/locales/features/roadmap.js';
import {
  persistLocale,
  readPersistedLocale,
  resolveInitialLocale,
  translateWithCatalogs,
  type AppLocale,
  type MessageTree
} from '../../../client/src/shared/i18n/types.js';

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
    roadmap: roadmapEn
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
    roadmap: roadmapPt
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
    roadmap: roadmapEs
  })
};

function leafKeys(tree: MessageTree, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push(path);
    else if (v && typeof v === 'object') out.push(...leafKeys(v as MessageTree, path));
  }
  return out.sort();
}

const FEATURE_ROOTS = [
  'wallet',
  'shop',
  'inventory',
  'wheel',
  'merge',
  'luckyBoxes',
  'blackMarket',
  'profile',
  'servers',
  'ranking',
  'partnerGames',
  'roadmap',
  'mining',
  'auth',
  'shell'
] as const;

describe('feature catalog key parity', () => {
  for (const root of FEATURE_ROOTS) {
    it(`${root} leaf keys match across en / pt-BR / es`, () => {
      const enKeys = leafKeys((CATALOGS.en[root] as MessageTree) ?? {});
      const ptKeys = leafKeys((CATALOGS['pt-BR'][root] as MessageTree) ?? {});
      const esKeys = leafKeys((CATALOGS.es[root] as MessageTree) ?? {});
      expect(enKeys.length).toBeGreaterThan(0);
      expect(ptKeys).toEqual(enKeys);
      expect(esKeys).toEqual(enKeys);
    });
  }
});

describe('feature translations resolve (no raw-key fallback)', () => {
  const sampleKeys = [
    'wallet.title',
    'shop.title',
    'inventory.depotTitle',
    'wheel.title',
    'merge.title',
    'luckyBoxes.title',
    'blackMarket.title',
    'profile.consoleTitle',
    'servers.room.defaultTitle',
    'servers.room.confirmPurchase',
    'ranking.titleGlobal',
    'partnerGames.title',
    'roadmap.title',
    'mining.loadingRoom',
    'auth.signIn',
    'shell.leaveManagedAccount'
  ];

  it('sample migrated keys differ from the key path in all locales', () => {
    for (const key of sampleKeys) {
      for (const locale of ['en', 'pt-BR', 'es'] as AppLocale[]) {
        const text = translateWithCatalogs(CATALOGS, locale, key);
        expect(text).not.toBe(key);
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });

  it('PT-BR → EN updates wallet feature text', () => {
    const pt = translateWithCatalogs(CATALOGS, 'pt-BR', 'wallet.title');
    const enText = translateWithCatalogs(CATALOGS, 'en', 'wallet.title');
    expect(pt).not.toBe(enText);
  });

  it('EN → ES updates shop feature text', () => {
    const enText = translateWithCatalogs(CATALOGS, 'en', 'shop.title');
    const esText = translateWithCatalogs(CATALOGS, 'es', 'shop.title');
    expect(enText).not.toBe(esText);
  });

  it('interpolation works on servers.room.capacityLine', () => {
    const text = translateWithCatalogs(CATALOGS, 'en', 'servers.room.capacityLine', {
      placed: 2,
      capacity: 8
    });
    expect(text).toContain('2');
    expect(text).toContain('8');
    expect(text).not.toContain('{{');
  });

  it('PT-BR → EN updates ServerRoom chrome', () => {
    const pt = translateWithCatalogs(CATALOGS, 'pt-BR', 'servers.room.confirmPurchase');
    const enText = translateWithCatalogs(CATALOGS, 'en', 'servers.room.confirmPurchase');
    expect(pt).not.toBe(enText);
  });

  it('EN → ES updates ServerRoom chrome', () => {
    const enText = translateWithCatalogs(CATALOGS, 'en', 'servers.room.powerOn');
    const esText = translateWithCatalogs(CATALOGS, 'es', 'servers.room.powerOn');
    expect(enText).not.toBe(esText);
  });
});

describe('reload keeps locale + translated content', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persisted locale drives resolveInitialLocale and translated wallet string', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
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
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { languages: ['en-US'], language: 'en-US' }
    });

    persistLocale('es', { manual: true });
    expect(readPersistedLocale()).toBe('es');
    expect(resolveInitialLocale()).toBe('es');
    const text = translateWithCatalogs(CATALOGS, resolveInitialLocale(), 'wallet.title');
    expect(text).toBe(translateWithCatalogs(CATALOGS, 'es', 'wallet.title'));
    expect(text).not.toBe(translateWithCatalogs(CATALOGS, 'en', 'wallet.title'));
  });
});
