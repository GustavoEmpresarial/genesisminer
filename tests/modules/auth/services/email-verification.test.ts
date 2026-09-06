import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('buildSignedEmailVerificationToken / parseSignedEmailVerificationToken', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_FLOW_TOKEN_SECRET', 'a'.repeat(32));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('token construído é parseável de volta pro mesmo e-mail', async () => {
    const { buildSignedEmailVerificationToken, parseSignedEmailVerificationToken } = await import(
      '../../../../server/modules/auth/services/email-verification.js'
    );
    const expiry = Date.now() + 1000;
    const token = buildSignedEmailVerificationToken('User@Example.com', expiry);
    const parsed = parseSignedEmailVerificationToken(token);
    expect(parsed).toEqual({ email: 'user@example.com', expiry });
  });

  it('rejeita token adulterado (assinatura não bate)', async () => {
    const { buildSignedEmailVerificationToken, parseSignedEmailVerificationToken } = await import(
      '../../../../server/modules/auth/services/email-verification.js'
    );
    const token = buildSignedEmailVerificationToken('user@example.com', Date.now() + 1000);
    const tampered = `${token.split('.')[0]}.deadbeef`;
    expect(parseSignedEmailVerificationToken(tampered)).toBeNull();
  });

  it('rejeita entrada vazia/malformada', async () => {
    const { parseSignedEmailVerificationToken } = await import('../../../../server/modules/auth/services/email-verification.js');
    expect(parseSignedEmailVerificationToken('')).toBeNull();
    expect(parseSignedEmailVerificationToken('sem-ponto')).toBeNull();
    expect(parseSignedEmailVerificationToken(undefined)).toBeNull();
  });
});

describe('getEmailVerificationFlags / userRequiresEmailVerification', () => {
  it('mapeia 1/0 do banco para booleanos', async () => {
    const { getEmailVerificationFlags } = await import('../../../../server/modules/auth/services/email-verification.js');
    expect(getEmailVerificationFlags({ email_verified: 1, email_verification_required: 0 })).toEqual({
      emailVerified: true,
      emailVerificationRequired: false
    });
  });

  it('exige verificação só quando required=1 e verified≠1', async () => {
    const { userRequiresEmailVerification } = await import('../../../../server/modules/auth/services/email-verification.js');
    expect(userRequiresEmailVerification({ email_verification_required: 1, email_verified: 0 })).toBe(true);
    expect(userRequiresEmailVerification({ email_verification_required: 1, email_verified: 1 })).toBe(false);
    expect(userRequiresEmailVerification({ email_verification_required: 0, email_verified: 0 })).toBe(false);
  });
});

describe('resendVerificationEmailIfPending / verifyEmailTokenAndActivate', () => {
  let prismaMock: Record<string, any>;
  let callWalletReferralCreditOnEmailVerified: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('AUTH_FLOW_TOKEN_SECRET', 'a'.repeat(32));
    const txLike = {
      users: {
        findFirst: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue(undefined),
        updateMany: vi.fn().mockResolvedValue(undefined)
      },
      referrals: { findFirst: vi.fn().mockResolvedValue(null) },
      game_states: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue(undefined) },
      access_level_referral_models: { findUnique: vi.fn().mockResolvedValue(null) },
      referral_models: { findFirst: vi.fn().mockResolvedValue(null) },
      $queryRaw: vi.fn().mockResolvedValue([{ referral_bonus_claimed: 0 }]),
      $executeRaw: vi.fn().mockResolvedValue(undefined)
    };
    prismaMock = {
      prisma: {
        ...txLike,
        $transaction: vi.fn((cb: any) => cb(txLike))
      }
    };
    callWalletReferralCreditOnEmailVerified = vi.fn().mockResolvedValue({ ok: true, skipped: true });
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../server/shared/security/mailer.js', () => ({ sendVerificationEmail: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('../../../../server/modules/wallet/services/wallet-worker-client.js', () => ({
      callWalletReferralCreditOnEmailVerified
    }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../server/shared/security/mailer.js');
    vi.doUnmock('../../../../server/modules/wallet/services/wallet-worker-client.js');
  });

  it('resendVerificationEmailIfPending não faz nada se a conta não existe', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue(null);
    const { resendVerificationEmailIfPending } = await import('../../../../server/modules/auth/services/email-verification.js');
    await resendVerificationEmailIfPending('nope@example.com');
    expect(prismaMock.prisma.users.updateMany).not.toHaveBeenCalled();
  });

  it('resendVerificationEmailIfPending não faz nada se já está verificado', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue({
      email: 'user@example.com',
      email_verification_required: 1,
      email_verified: 1
    });
    const { resendVerificationEmailIfPending } = await import('../../../../server/modules/auth/services/email-verification.js');
    await resendVerificationEmailIfPending('user@example.com');
    expect(prismaMock.prisma.users.updateMany).not.toHaveBeenCalled();
  });

  it('resendVerificationEmailIfPending reenvia quando pendente', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue({
      email: 'user@example.com',
      email_verification_required: 1,
      email_verified: 0
    });
    const { resendVerificationEmailIfPending } = await import('../../../../server/modules/auth/services/email-verification.js');
    await resendVerificationEmailIfPending('user@example.com');
    expect(prismaMock.prisma.users.updateMany).toHaveBeenCalled();
  });

  it('verifyEmailTokenAndActivate rejeita token inválido/malformado', async () => {
    const { verifyEmailTokenAndActivate } = await import('../../../../server/modules/auth/services/email-verification.js');
    const result = await verifyEmailTokenAndActivate('lixo-nao-token');
    expect(result).toEqual({ ok: false, error: expect.any(String), status: 400 });
  });

  it('verifyEmailTokenAndActivate rejeita token expirado', async () => {
    const { buildSignedEmailVerificationToken, verifyEmailTokenAndActivate } = await import(
      '../../../../server/modules/auth/services/email-verification.js'
    );
    const expired = buildSignedEmailVerificationToken('user@example.com', Date.now() - 1000);
    const result = await verifyEmailTokenAndActivate(expired);
    expect(result).toEqual({ ok: false, error: expect.any(String), status: 403 });
  });

  it('verifyEmailTokenAndActivate 404 se a conta não existe', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue(null);
    const { buildSignedEmailVerificationToken, verifyEmailTokenAndActivate } = await import(
      '../../../../server/modules/auth/services/email-verification.js'
    );
    const token = buildSignedEmailVerificationToken('user@example.com', Date.now() + 1000);
    const result = await verifyEmailTokenAndActivate(token);
    expect(result).toEqual({ ok: false, error: expect.any(String), status: 404 });
  });

  it('verifyEmailTokenAndActivate: já verificado devolve alreadyVerified e tenta referral credit idempotente', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue({ id: 1, email_verified: 1, email_verification_token_hash: null });
    const { buildSignedEmailVerificationToken, verifyEmailTokenAndActivate } = await import(
      '../../../../server/modules/auth/services/email-verification.js'
    );
    const token = buildSignedEmailVerificationToken('user@example.com', Date.now() + 1000);
    const result = await verifyEmailTokenAndActivate(token);
    expect(result).toMatchObject({ ok: true, alreadyVerified: true });
    expect(prismaMock.prisma.users.update).not.toHaveBeenCalled();
    expect(callWalletReferralCreditOnEmailVerified).toHaveBeenCalledWith(
      expect.objectContaining({ verifiedUserId: 1 })
    );
  });

  it('verifyEmailTokenAndActivate: sucesso marca email_verified=1 e chama referral worker', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue({ id: 1, email_verified: 0, email_verification_token_hash: null });
    const { buildSignedEmailVerificationToken, verifyEmailTokenAndActivate } = await import(
      '../../../../server/modules/auth/services/email-verification.js'
    );
    const token = buildSignedEmailVerificationToken('user@example.com', Date.now() + 1000);
    const result = await verifyEmailTokenAndActivate(token);
    expect(result).toMatchObject({ ok: true });
    expect(prismaMock.prisma.users.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { email_verified: 1, email_verification_required: 0, email_verification_token_hash: null }
    });
    expect(callWalletReferralCreditOnEmailVerified).toHaveBeenCalledWith(
      expect.objectContaining({ verifiedUserId: 1 })
    );
  });

  it('verifyEmailTokenAndActivate: hash de token divergente (reenvio mais recente) rejeita', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue({
      id: 1,
      email_verified: 0,
      email_verification_token_hash: 'a'.repeat(64)
    });
    const { buildSignedEmailVerificationToken, verifyEmailTokenAndActivate } = await import(
      '../../../../server/modules/auth/services/email-verification.js'
    );
    const token = buildSignedEmailVerificationToken('user@example.com', Date.now() + 1000);
    const result = await verifyEmailTokenAndActivate(token);
    expect(result).toEqual({ ok: false, error: expect.any(String), status: 403 });
  });
});
