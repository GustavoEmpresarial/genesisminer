/**
 * Invalidação de estado local por build — garante que um browser com estado de
 * build antiga não continua a assumir sessão viva (401 em cascata pós-deploy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_MANUAL_KEY, LOCALE_STORAGE_KEY } from '../../../client/src/shared/i18n/types.js';
import {
  BUILD_META_NAME,
  BUILD_STAMP_KEY,
  readBuildIdFromDocument,
  resetLocalStateOnNewBuild
} from '../../../client/src/shared/runtime/build-reset.js';

const SESSION_HINT_KEY = 'genesis_has_session';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
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
  } as Storage;
}

function installStorages(initial: Record<string, string> = {}): {
  local: Storage;
  session: Storage;
} {
  const local = memoryStorage(initial);
  const session = memoryStorage({ some_flash: '1' });
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  return { local, session };
}

function installDocumentWithBuild(buildId: string | null): void {
  vi.stubGlobal('document', {
    querySelector: (selector: string) => {
      if (buildId == null || selector !== `meta[name="${BUILD_META_NAME}"]`) return null;
      return { getAttribute: (attr: string) => (attr === 'content' ? buildId : null) };
    }
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readBuildIdFromDocument', () => {
  it('lê o selo da meta tag', () => {
    installDocumentWithBuild('abc123');
    expect(readBuildIdFromDocument()).toBe('abc123');
  });

  it('sem meta tag devolve null', () => {
    installDocumentWithBuild(null);
    expect(readBuildIdFromDocument()).toBeNull();
  });

  it('meta com content vazio devolve null', () => {
    vi.stubGlobal('document', {
      querySelector: () => ({ getAttribute: () => '   ' })
    });
    expect(readBuildIdFromDocument()).toBeNull();
  });
});

describe('resetLocalStateOnNewBuild', () => {
  it('primeira visita: limpa estado volátil e grava o selo', () => {
    const { local } = installStorages({ [SESSION_HINT_KEY]: '1', adminActiveTab: 'reports' });
    expect(resetLocalStateOnNewBuild('build-1')).toBe(true);
    expect(local.getItem(SESSION_HINT_KEY)).toBeNull();
    expect(local.getItem('adminActiveTab')).toBeNull();
    expect(local.getItem(BUILD_STAMP_KEY)).toBe('build-1');
  });

  it('mesmo selo: não mexe em nada', () => {
    const { local } = installStorages({
      [BUILD_STAMP_KEY]: 'build-1',
      [SESSION_HINT_KEY]: '1',
      adminActiveTab: 'reports'
    });
    expect(resetLocalStateOnNewBuild('build-1')).toBe(false);
    expect(local.getItem(SESSION_HINT_KEY)).toBe('1');
    expect(local.getItem('adminActiveTab')).toBe('reports');
  });

  it('selo novo: apaga o hint de sessão da build anterior', () => {
    const { local } = installStorages({ [BUILD_STAMP_KEY]: 'build-1', [SESSION_HINT_KEY]: '1' });
    expect(resetLocalStateOnNewBuild('build-2')).toBe(true);
    expect(local.getItem(SESSION_HINT_KEY)).toBeNull();
    expect(local.getItem(BUILD_STAMP_KEY)).toBe('build-2');
  });

  it('preserva a preferência de idioma do utilizador', () => {
    const { local } = installStorages({
      [BUILD_STAMP_KEY]: 'build-1',
      [LOCALE_STORAGE_KEY]: 'pt-BR',
      [LOCALE_MANUAL_KEY]: '1',
      [SESSION_HINT_KEY]: '1'
    });
    resetLocalStateOnNewBuild('build-2');
    expect(local.getItem(LOCALE_STORAGE_KEY)).toBe('pt-BR');
    expect(local.getItem(LOCALE_MANUAL_KEY)).toBe('1');
    expect(local.getItem(SESSION_HINT_KEY)).toBeNull();
  });

  it('selo novo limpa também o sessionStorage', () => {
    const { session } = installStorages({ [BUILD_STAMP_KEY]: 'build-1' });
    resetLocalStateOnNewBuild('build-2');
    expect(session.length).toBe(0);
  });

  it('sem selo (HTML antigo em cache) não limpa nada', () => {
    const { local } = installStorages({ [SESSION_HINT_KEY]: '1' });
    expect(resetLocalStateOnNewBuild(null)).toBe(false);
    expect(local.getItem(SESSION_HINT_KEY)).toBe('1');
  });

  it('localStorage indisponível não rebenta', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(resetLocalStateOnNewBuild('build-1')).toBe(false);
  });

  it('storage que lança em removeItem não rebenta o arranque', () => {
    const hostile = memoryStorage({ [SESSION_HINT_KEY]: '1' });
    vi.stubGlobal('localStorage', {
      ...hostile,
      getItem: () => null,
      length: 1,
      key: () => SESSION_HINT_KEY,
      removeItem: () => {
        throw new Error('quota');
      }
    } as unknown as Storage);
    expect(resetLocalStateOnNewBuild('build-1')).toBe(false);
  });
});
