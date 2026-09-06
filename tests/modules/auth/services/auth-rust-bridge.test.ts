import { afterEach, describe, expect, it, vi } from 'vitest';

describe('auth-rust-bridge', () => {
  const orig = process.env.GENESIS_AUTH_RUST;

  afterEach(() => {
    if (orig === undefined) delete process.env.GENESIS_AUTH_RUST;
    else process.env.GENESIS_AUTH_RUST = orig;
    vi.resetModules();
    vi.doUnmock('../../../../server/shared/rust/genesis-native.js');
  });

  it('flag off: rust helpers return null/undefined (TS path)', async () => {
    delete process.env.GENESIS_AUTH_RUST;
    const bridge = await import('../../../../server/modules/auth/services/auth-rust-bridge.js');
    expect(bridge.rustValidateLoginEmail('a@b.com')).toBeNull();
    expect(bridge.rustValidatePasswordStrength('hunter2x')).toBeNull();
  });

  it('flag on with native mock: validate email via JSON', async () => {
    process.env.GENESIS_AUTH_RUST = '1';
    vi.doMock('../../../../server/shared/rust/genesis-native.js', () => ({
      genesisAuthRustEnabled: () => true,
      loadGenesisNative: () => ({
        authValidateLoginEmailJson: () => JSON.stringify({ ok: true })
      })
    }));
    const bridge = await import('../../../../server/modules/auth/services/auth-rust-bridge.js');
    expect(bridge.rustValidateLoginEmail('a@b.com')).toEqual({ ok: true });
  });

  it('real native addon when present (smoke)', async () => {
    process.env.GENESIS_AUTH_RUST = '1';
    const { loadGenesisNative } = await import('../../../../server/shared/rust/genesis-native.js');
    const native = loadGenesisNative();
    if (!native?.authPing || native.authPing() !== 'genesis-auth-ok') {
      return;
    }
    const bridge = await import('../../../../server/modules/auth/services/auth-rust-bridge.js');
    expect(bridge.rustValidateLoginEmail('user@gmail.com')).toEqual({ ok: true });
    expect(bridge.rustValidateLoginEmail('')).toEqual({
      ok: false,
      error: expect.any(String)
    });
  });
});
