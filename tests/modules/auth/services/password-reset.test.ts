import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'a'.repeat(32);
const SVC = '../../../../server/modules/auth/services/password-reset.js';
const PRISMA = '../../../../server/core/database/prisma.js';
const MAILER = '../../../../server/shared/security/mailer.js';
const AUTH_WORKER = '../../../../server/modules/auth/services/auth-worker-client.js';

describe('password-reset service', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('AUTH_FLOW_TOKEN_SECRET', SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock(PRISMA);
    vi.doUnmock(MAILER);
    vi.doUnmock(AUTH_WORKER);
  });

  it('build + parse round-trip', async () => {
    const { buildSignedPasswordResetToken, parseSignedPasswordResetToken } = await import(SVC);
    const expiry = Date.now() + 60_000;
    const token = buildSignedPasswordResetToken('User@Example.com', expiry);
    const parsed = parseSignedPasswordResetToken(token);
    expect(parsed).toEqual({ email: 'user@example.com', expiry });
  });

  it('parse rejects tampered signature', async () => {
    const { buildSignedPasswordResetToken, parseSignedPasswordResetToken } = await import(SVC);
    const token = buildSignedPasswordResetToken('a@b.com', Date.now() + 60_000);
    const [payload] = token.split('.');
    const bad = `${payload}.${'00'.repeat(32)}`;
    const parsed = parseSignedPasswordResetToken(bad);
    expect(parsed).toMatchObject({ status: 403 });
  });

  it('requestPasswordResetByEmail persists hash and sends mail when user exists', async () => {
    const sendResetEmail = vi.fn().mockResolvedValue({});
    const findFirst = vi.fn().mockResolvedValue({ id: 7, email: 'a@b.com' });
    const update = vi.fn().mockResolvedValue({});
    vi.doMock(PRISMA, () => ({
      prisma: { users: { findFirst, update } }
    }));
    vi.doMock(MAILER, () => ({ sendResetEmail }));

    const { requestPasswordResetByEmail } = await import(SVC);
    const result = await requestPasswordResetByEmail('a@b.com');
    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalled();
    const data = update.mock.calls[0][0].data;
    expect(data.password_reset_token_hash).toMatch(/^[a-f0-9]{64}$/);
    await vi.waitFor(() => expect(sendResetEmail).toHaveBeenCalled());
  });

  it('requestPasswordResetByEmail still returns ok when user missing', async () => {
    vi.doMock(PRISMA, () => ({
      prisma: { users: { findFirst: vi.fn().mockResolvedValue(null) } }
    }));
    vi.doMock(MAILER, () => ({
      sendResetEmail: vi.fn()
    }));
    const { requestPasswordResetByEmail } = await import(SVC);
    const result = await requestPasswordResetByEmail('missing@x.com');
    expect(result).toMatchObject({ ok: true });
  });

  it('consumePasswordResetAndSetPassword updates password and clears token', async () => {
    const findFirst = vi.fn();
    const update = vi.fn();
    const callAuthSessionDeleteByUser = vi.fn().mockResolvedValue({ ok: true, deletedCount: 1 });
    vi.doMock(PRISMA, () => ({
      prisma: {
        users: { findFirst, update }
      }
    }));
    vi.doMock(MAILER, () => ({ sendResetEmail: vi.fn() }));
    vi.doMock(AUTH_WORKER, async () => {
      const actual = await vi.importActual<typeof import('../../../../server/modules/auth/services/auth-worker-client.js')>(
        AUTH_WORKER
      );
      return {
        ...actual,
        callAuthSessionDeleteByUser,
        authWorkerBcrypt: {
          hash: vi.fn().mockResolvedValue('hashed'),
          compare: vi.fn()
        }
      };
    });

    const mod = await import(SVC);
    const expiry = Date.now() + 60_000;
    const token = mod.buildSignedPasswordResetToken('a@b.com', expiry);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    findFirst.mockResolvedValue({
      id: 3,
      password_reset_token_hash: hash,
      password_reset_token_expires_at: BigInt(expiry)
    });

    const result = await mod.consumePasswordResetAndSetPassword(token, 'newpass99');
    expect(result).toEqual({ ok: true, userId: 3 });
    expect(callAuthSessionDeleteByUser).toHaveBeenCalledWith({ userId: 3 });
    expect(update).toHaveBeenCalled();
  });
});
