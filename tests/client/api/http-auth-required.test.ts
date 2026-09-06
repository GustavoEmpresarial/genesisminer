/**
 * apiFetch — refresh-on-401 + single AUTH_REQUIRED_EVENT (session expired).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_FLASH_KEY,
  AUTH_FLASH_SESSION_EXPIRED,
  AUTH_REQUIRED_EVENT,
  apiFetch,
  getSessionHint,
  isAuthFailureHandling,
  notifyAuthRequired,
  resetAuthFailureHandlingForTests,
  setSessionHint,
  shouldSkipAuthRefreshRetry
} from '../../../client/src/shared/api/http.js';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    key: (i: number) => [...map.keys()][i] ?? null
  };
}

function jsonRes(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('apiFetch / session expired', () => {
  const listeners = new Map<string, Set<EventListener>>();

  beforeEach(() => {
    resetAuthFailureHandlingForTests();
    listeners.clear();
    const localStorage = memoryStorage();
    const sessionStorage = memoryStorage();
    vi.stubGlobal('window', {
      localStorage,
      sessionStorage,
      addEventListener: (type: string, fn: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: EventListener) => {
        listeners.get(type)?.delete(fn);
      },
      dispatchEvent: (ev: Event) => {
        const set = listeners.get(ev.type);
        if (set) for (const fn of set) fn(ev);
        return true;
      }
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAuthFailureHandlingForTests();
  });

  it('sessão válida (200) — sem event, hint intacta', async () => {
    setSessionHint(true);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonRes(200, { ok: true }));

    const events: Event[] = [];
    window.addEventListener(AUTH_REQUIRED_EVENT, (e) => events.push(e));

    const res = await apiFetch('/api/inventory/state');
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0);
    expect(getSessionHint()).toBe(true);
    expect(isAuthFailureHandling()).toBe(false);
  });

  it('401 sem hint (anónimo) — não dispara logout', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonRes(401, { error: 'No session' }));

    const events: Event[] = [];
    window.addEventListener(AUTH_REQUIRED_EVENT, (e) => events.push(e));

    const res = await apiFetch('/api/session');
    expect(res.status).toBe(401);
    expect(events).toHaveLength(0);
    expect(isAuthFailureHandling()).toBe(false);
  });

  it('token expirado: hint → refresh falha → um AUTH_REQUIRED + flash', async () => {
    setSessionHint(true);
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonRes(401, { code: 'AUTH_ACCESS_EXPIRED' }))
      .mockResolvedValueOnce(jsonRes(401, { error: 'refresh failed' }));

    const events: Event[] = [];
    window.addEventListener(AUTH_REQUIRED_EVENT, (e) => events.push(e));

    const res = await apiFetch('/api/inventory/state');
    expect(res.status).toBe(401);
    expect(events).toHaveLength(1);
    expect(getSessionHint()).toBe(false);
    expect(isAuthFailureHandling()).toBe(true);
    expect(window.sessionStorage.getItem(AUTH_FLASH_KEY)).toBe(AUTH_FLASH_SESSION_EXPIRED);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/auth/refresh');
  });

  it('múltiplos 401 simultâneos — um único notify', async () => {
    setSessionHint(true);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/auth/refresh')) return jsonRes(401);
      return jsonRes(401, { code: 'AUTH_REQUIRED' });
    });

    const events: Event[] = [];
    window.addEventListener(AUTH_REQUIRED_EVENT, (e) => events.push(e));

    const results = await Promise.all([apiFetch('/api/a'), apiFetch('/api/b'), apiFetch('/api/c')]);
    expect(results.every((r) => r.status === 401)).toBe(true);
    expect(events).toHaveLength(1);
    expect(isAuthFailureHandling()).toBe(true);
  });

  it('403 não dispara AUTH_REQUIRED — sessão permanece', async () => {
    setSessionHint(true);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonRes(403, { error: 'Access denied' }));

    const events: Event[] = [];
    window.addEventListener(AUTH_REQUIRED_EVENT, (e) => events.push(e));

    const res = await apiFetch('/api/admin/dashboard');
    expect(res.status).toBe(403);
    expect(events).toHaveLength(0);
    expect(getSessionHint()).toBe(true);
    expect(isAuthFailureHandling()).toBe(false);
  });

  it('refresh OK — retry original, sem event', async () => {
    setSessionHint(true);
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonRes(401))
      .mockResolvedValueOnce(jsonRes(200))
      .mockResolvedValueOnce(jsonRes(200, { stock: {} }));

    const events: Event[] = [];
    window.addEventListener(AUTH_REQUIRED_EVENT, (e) => events.push(e));

    const res = await apiFetch('/api/inventory/state');
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0);
    expect(getSessionHint()).toBe(true);
  });

  it('setSessionHint(true) limpa lock para novo ciclo pós-login', () => {
    notifyAuthRequired('/api/x', 401);
    expect(isAuthFailureHandling()).toBe(true);
    setSessionHint(true);
    expect(isAuthFailureHandling()).toBe(false);
  });

  it('shouldSkipAuthRefreshRetry cobre rotas públicas de auth', () => {
    expect(shouldSkipAuthRefreshRetry('/api/login')).toBe(true);
    expect(shouldSkipAuthRefreshRetry('/api/register')).toBe(true);
    expect(shouldSkipAuthRefreshRetry('/api/auth/refresh')).toBe(true);
    expect(shouldSkipAuthRefreshRetry('/api/inventory/state')).toBe(false);
  });
});
