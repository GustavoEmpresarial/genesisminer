import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const callAuthTurnstileVerify = vi.fn();

vi.mock('../../../server/modules/auth/services/auth-worker-client.js', () => ({
  callAuthTurnstileVerify: (...args: unknown[]) => callAuthTurnstileVerify(...args)
}));

import { getTurnstileSiteKey, isTurnstileEnabled, verifyTurnstileToken } from '../../../server/shared/security/cloudflare-turnstile.js';

function fakeReq(): { headers: Record<string, string> } {
  return { headers: {} };
}

describe('isTurnstileEnabled / getTurnstileSiteKey', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('desligado por padrão', () => {
    expect(isTurnstileEnabled()).toBe(false);
  });

  it('liga com ENABLED=1 + site key (sem secret no app)', () => {
    vi.stubEnv('CLOUDFLARE_TURNSTILE_ENABLED', '1');
    vi.stubEnv('CLOUDFLARE_TURNSTILE_SITE_KEY', 'site-key');
    expect(isTurnstileEnabled()).toBe(true);
    expect(getTurnstileSiteKey()).toBe('site-key');
  });

  it('não liga só com ENABLED sem site key', () => {
    vi.stubEnv('CLOUDFLARE_TURNSTILE_ENABLED', '1');
    vi.stubEnv('CLOUDFLARE_TURNSTILE_SITE_KEY', '');
    expect(isTurnstileEnabled()).toBe(false);
  });
});

describe('verifyTurnstileToken', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    callAuthTurnstileVerify.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('delega ao worker com token + remoteip omitido quando unknown', async () => {
    callAuthTurnstileVerify.mockResolvedValue({ ok: true });
    const result = await verifyTurnstileToken(fakeReq(), 'tok-123');
    expect(result).toEqual({ ok: true });
    expect(callAuthTurnstileVerify).toHaveBeenCalledWith({
      token: 'tok-123',
      remoteip: undefined
    });
  });

  it('quando enabled, token vazio → 400 sem chamar worker', async () => {
    vi.stubEnv('CLOUDFLARE_TURNSTILE_ENABLED', '1');
    vi.stubEnv('CLOUDFLARE_TURNSTILE_SITE_KEY', 'site-key');
    const result = await verifyTurnstileToken(fakeReq(), '');
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Complete the captcha before continuing.'
    });
    expect(callAuthTurnstileVerify).not.toHaveBeenCalled();
  });

  it('quando disabled, token não-string vira string vazia pro worker', async () => {
    callAuthTurnstileVerify.mockResolvedValue({ ok: true });
    const result = await verifyTurnstileToken(fakeReq(), 123);
    expect(result).toEqual({ ok: true });
    expect(callAuthTurnstileVerify).toHaveBeenCalledWith({
      token: '',
      remoteip: undefined
    });
  });

  it('propaga 502 do worker (fail-closed)', async () => {
    callAuthTurnstileVerify.mockResolvedValue({
      ok: false,
      status: 502,
      error: 'Could not validate captcha right now. Please try again in a moment.'
    });
    const result = await verifyTurnstileToken(fakeReq(), 'tok-123');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
  });

  it('propaga 503 misconfigured do worker', async () => {
    callAuthTurnstileVerify.mockResolvedValue({
      ok: false,
      status: 503,
      error: 'Turnstile misconfigured.'
    });
    const result = await verifyTurnstileToken(fakeReq(), 'tok');
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: 'Turnstile misconfigured.'
    });
  });

  it('propaga 503 quando GENESIS_AUTH_URL unset (via client)', async () => {
    callAuthTurnstileVerify.mockResolvedValue({
      ok: false,
      status: 503,
      error: 'GENESIS_AUTH_URL unset'
    });
    const result = await verifyTurnstileToken(fakeReq(), 'tok');
    expect(result).toEqual({ ok: false, status: 503, error: 'GENESIS_AUTH_URL unset' });
  });
});
