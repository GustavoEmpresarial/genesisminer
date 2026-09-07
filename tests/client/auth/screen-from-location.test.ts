/**
 * `screenFromLocation` — the email-verify deep link must survive the token being
 * stripped from the URL. It runs again on mount / popstate when the URL is
 * already `/verificar-email` (no token); a regression there dropped the user
 * onto the password-reset form ("abre a seção de redefinição de senha").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screenFromLocation } from '../../../client/src/features/auth/lib/screenFromLocation.js';

type W = {
  location: { pathname: string; search: string };
  history: { state: unknown; replaceState: (s: unknown, _t: string, url: string) => void };
};

let savedWindow: unknown;

function installWindow(pathname: string, search = ''): W {
  const w: W = {
    location: { pathname, search },
    history: {
      state: null,
      replaceState(s: unknown, _t: string, url: string) {
        this.state = s;
        const [p, q] = url.split('?');
        w.location.pathname = p ?? '/';
        w.location.search = q ? `?${q}` : '';
      }
    }
  };
  (globalThis as { window?: unknown }).window = w;
  return w;
}

beforeEach(() => {
  savedWindow = (globalThis as { window?: unknown }).window;
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = savedWindow;
});

describe('screenFromLocation — verify deep link', () => {
  it('keeps the verify token after the URL is stripped and the fn re-runs', () => {
    installWindow('/verificar-email/eyJhIjoxfQ.sig');

    const first = screenFromLocation('login');
    expect(first).toEqual({ screen: 'verify', recoveryToken: null, verifyToken: 'eyJhIjoxfQ.sig' });
    // Token stripped from the URL…
    expect((globalThis as { window: W }).window.location.pathname).toBe('/verificar-email');

    // …but a second call (mount effect / popstate) still resolves it.
    const second = screenFromLocation('login');
    expect(second.screen).toBe('verify');
    expect(second.verifyToken).toBe('eyJhIjoxfQ.sig');
  });

  it('keeps the recovery token after the URL is stripped and the fn re-runs', () => {
    installWindow('/redefinir-senha/eyJ0.abc');

    const first = screenFromLocation('login');
    expect(first.screen).toBe('recovery');
    expect(first.recoveryToken).toBe('eyJ0.abc');

    const second = screenFromLocation('recovery');
    expect(second.screen).toBe('recovery');
    expect(second.recoveryToken).toBe('eyJ0.abc');
  });

  it('bare /verificar-email with no token and no stash stays token-less', () => {
    installWindow('/verificar-email');
    const r = screenFromLocation('login');
    expect(r).toEqual({ screen: 'verify', recoveryToken: null, verifyToken: null });
  });
});
