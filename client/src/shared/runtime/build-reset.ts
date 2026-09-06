/**
 * Invalidação de estado local por build (par do `server/bootstrap/spa-build-stamp.ts`).
 *
 * A cada deploy com bundle novo o servidor muda `<meta name="genesis-build">`. No
 * arranque comparamos com o selo guardado: se mudou, apagamos estado volátil de
 * `localStorage` (ex. `genesis_has_session`, que fazia o browser assumir sessão viva
 * e disparar 401 em cascata nas APIs autenticadas) e o `sessionStorage`.
 *
 * Preferências explícitas do utilizador (idioma) sobrevivem — ver `PRESERVED_KEYS`.
 */
import { LOCALE_MANUAL_KEY, LOCALE_STORAGE_KEY } from '../i18n/types';

export const BUILD_STAMP_KEY = 'genesis_build';
export const BUILD_META_NAME = 'genesis-build';

/** Escolhas deliberadas do utilizador — limpá-las seria regressão de UX, não cache. */
const PRESERVED_KEYS: readonly string[] = [BUILD_STAMP_KEY, LOCALE_STORAGE_KEY, LOCALE_MANUAL_KEY];

function getLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readBuildIdFromDocument(): string | null {
  try {
    const meta = globalThis.document?.querySelector(`meta[name="${BUILD_META_NAME}"]`);
    const content = meta?.getAttribute('content')?.trim();
    return content ? content : null;
  } catch {
    return null;
  }
}

/** `Storage.key(i)` em vez de `Object.keys` — não apanha métodos de mocks/polyfills. */
function listStoredKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key != null) keys.push(key);
  }
  return keys;
}

/**
 * Limpa estado volátil se o selo de build mudou e guarda o novo.
 * Devolve `true` quando limpou (útil para testes/telemetria).
 */
export function resetLocalStateOnNewBuild(buildId: string | null): boolean {
  if (!buildId) return false;
  const storage = getLocalStorage();
  if (!storage) return false;
  try {
    if (storage.getItem(BUILD_STAMP_KEY) === buildId) return false;

    for (const key of listStoredKeys(storage)) {
      if (!PRESERVED_KEYS.includes(key)) storage.removeItem(key);
    }
    storage.setItem(BUILD_STAMP_KEY, buildId);
    try {
      globalThis.sessionStorage?.clear();
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

/** Chamado uma vez em `main.tsx`, antes de renderizar o React. */
export function applyBuildResetOnBoot(): boolean {
  return resetLocalStateOnNewBuild(readBuildIdFromDocument());
}
