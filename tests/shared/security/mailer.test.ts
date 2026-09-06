import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const callAuthMailReset = vi.fn();
const callAuthMailVerify = vi.fn();

vi.mock('../../../server/modules/auth/services/auth-worker-client.js', () => ({
  callAuthMailReset: (...args: unknown[]) => callAuthMailReset(...args),
  callAuthMailVerify: (...args: unknown[]) => callAuthMailVerify(...args)
}));

describe('mailer', () => {
  beforeEach(() => {
    vi.resetModules();
    callAuthMailReset.mockReset().mockResolvedValue({ ok: true });
    callAuthMailVerify.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sendResetEmail delega ao worker com validade default 60min', async () => {
    const { sendResetEmail, DEFAULT_RESET_LINK_VALIDITY_MINUTES } = await import(
      '../../../server/shared/security/mailer.js'
    );
    await sendResetEmail('user@example.com', 'tok en+/', {});
    expect(callAuthMailReset).toHaveBeenCalledWith({
      email: 'user@example.com',
      resetToken: 'tok en+/',
      validityMinutes: DEFAULT_RESET_LINK_VALIDITY_MINUTES
    });
    expect(DEFAULT_RESET_LINK_VALIDITY_MINUTES).toBe(60);
  });

  it('sendResetEmail respeita validityMinutes customizado', async () => {
    const { sendResetEmail } = await import('../../../server/shared/security/mailer.js');
    await sendResetEmail('user@example.com', 'tok', { validityMinutes: 15 });
    expect(callAuthMailReset).toHaveBeenCalledWith({
      email: 'user@example.com',
      resetToken: 'tok',
      validityMinutes: 15
    });
  });

  it('sendVerificationEmail delega com validade default 24h', async () => {
    const { sendVerificationEmail, DEFAULT_VERIFICATION_LINK_VALIDITY_HOURS } = await import(
      '../../../server/shared/security/mailer.js'
    );
    await sendVerificationEmail('user@example.com', 'vtok', {});
    expect(callAuthMailVerify).toHaveBeenCalledWith({
      email: 'user@example.com',
      verificationToken: 'vtok',
      validityHours: DEFAULT_VERIFICATION_LINK_VALIDITY_HOURS
    });
    expect(DEFAULT_VERIFICATION_LINK_VALIDITY_HOURS).toBe(24);
  });

  it('sendResetEmail throw quando worker falha', async () => {
    callAuthMailReset.mockResolvedValue({ ok: false, error: 'mail send failed' });
    const { sendResetEmail } = await import('../../../server/shared/security/mailer.js');
    await expect(sendResetEmail('user@example.com', 'tok', {})).rejects.toThrow('mail send failed');
  });

  it('sendResetEmail throw quando GENESIS_AUTH_URL unset', async () => {
    callAuthMailReset.mockImplementation(() => {
      throw new Error('GENESIS_AUTH_URL unset');
    });
    const { sendResetEmail } = await import('../../../server/shared/security/mailer.js');
    await expect(sendResetEmail('a@x.com', 'tok', {})).rejects.toThrow('GENESIS_AUTH_URL unset');
  });
});
