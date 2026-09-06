/**
 * Composition root: monta, uma única vez, as dependências transversais que os módulos
 * recebem injetadas (`register*ModuleRoutes(app, deps)`) — middlewares de auth, helpers
 * de infra, limiters específicos com valor/mensagem reais. Nenhum módulo de domínio
 * importa `bcryptjs`/constrói o seu próprio `isAdmin`/limiter — tudo nasce aqui.
 *
 * Os limiters usam `buildIpRateLimiter` (infra genérica, `core/http/rate-limit.ts`);
 * janela/máximo/mensagem de cada um migrados de legacy/backend/server.ts (limiters inline).
 */
import crypto from 'node:crypto';
import { buildIpRateLimiter, getClientIpFromRequest, parseCookies, parseRateLimit } from '../core/http/index.js';
import { emitMarketWs } from '../core/socket/market-ws.js';
import { createAuthenticateTokenMiddleware, createIsAdminMiddleware, issueJwtAuthCookies, revokeJwtRefreshForUser } from '../modules/auth/index.js';
import { EMAIL_ADDRESS_MAX_LENGTH } from '../modules/auth/services/login-validation.js';
import { authWorkerBcrypt } from '../modules/auth/services/auth-worker-client.js';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../shared/utils/time.js';

const IMG_DIR = process.env.IMG_DIR?.trim() || 'storage/media-seed';
const UPLOADS_DIR = process.env.IMG_UPLOADS_DIR?.trim() || 'storage/uploads';
const MINUTES_PER_WINDOW_15 = 15;

const PASSWORD_RESET_DEFAULT = 8;
const PASSWORD_RESET_MIN = 3;
const PASSWORD_RESET_MAX = 30;
const PASSWORD_RESET_CONFIRM_DEFAULT = 12;
const PASSWORD_RESET_CONFIRM_MIN = 3;
const PASSWORD_RESET_CONFIRM_MAX = 40;
const EMAIL_VERIFY_DEFAULT = 20;
const EMAIL_VERIFY_MIN = 5;
const EMAIL_VERIFY_MAX = 80;
const RESET_TOKEN_KEY_HASH_SLICE = 16;
const SIGNUP_DEFAULT = 8;
const SIGNUP_MIN = 3;
const SIGNUP_MAX = 30;
const REFRESH_DEFAULT = 60;
const REFRESH_MIN = 10;
const REFRESH_MAX = 240;
const REFERRAL_CLAIM_DEFAULT = 30;
const REFERRAL_CLAIM_MIN = 5;
const REFERRAL_CLAIM_MAX = 120;
const PROFILE_WALLET_MUTATION_MAX = 25;

/**
 * Constrói o objeto de dependências injetado em todo `register*ModuleRoutes`
 * (ver `./routes.ts`). Chamado uma única vez no boot (`./app.ts`); os
 * middlewares/limiters aqui construídos são singletons compartilhados por
 * todos os módulos que os recebem — não recriar por request.
 */
export function buildAppDeps() {
  const authenticateToken = createAuthenticateTokenMiddleware();
  const isAdmin = createIsAdminMiddleware({ parseCookies });
  const getClientIp = (req: Parameters<typeof getClientIpFromRequest>[0]) => getClientIpFromRequest(req);

  const emailRequestLimiter = buildIpRateLimiter({
    windowMs: MS_PER_HOUR,
    max: parseRateLimit(process.env.PASSWORD_RESET_EMAIL_MAX_PER_HOUR, PASSWORD_RESET_DEFAULT, PASSWORD_RESET_MIN, PASSWORD_RESET_MAX),
    normalizeIpKey: true,
    message: 'Too many password reset requests from this IP. Please try again later.'
  });

  const passwordResetRequestLimiter = buildIpRateLimiter({
    windowMs: MS_PER_HOUR,
    max: parseRateLimit(process.env.PASSWORD_RESET_EMAIL_MAX_PER_HOUR, PASSWORD_RESET_DEFAULT, PASSWORD_RESET_MIN, PASSWORD_RESET_MAX),
    normalizeIpKey: true,
    message: 'Too many password reset requests from this IP. Please try again later.'
  });

  const securePasswordResetLimiter = buildIpRateLimiter({
    windowMs: MS_PER_HOUR,
    max: parseRateLimit(
      process.env.PASSWORD_RESET_CONFIRM_MAX_PER_HOUR,
      PASSWORD_RESET_CONFIRM_DEFAULT,
      PASSWORD_RESET_CONFIRM_MIN,
      PASSWORD_RESET_CONFIRM_MAX
    ),
    normalizeIpKey: true,
    extraKeySuffix: (req) => {
      const token = req.body && typeof req.body.resetToken === 'string' ? req.body.resetToken : '';
      const tail = token
        ? crypto.createHash('sha256').update(token).digest('hex').slice(0, RESET_TOKEN_KEY_HASH_SLICE)
        : 'no-token';
      return tail;
    },
    message: 'Too many password reset attempts. Please try again later.'
  });

  const verifyAttemptLimiter = buildIpRateLimiter({
    windowMs: MINUTES_PER_WINDOW_15 * MS_PER_MINUTE,
    max: parseRateLimit(process.env.EMAIL_VERIFY_MAX_PER_15M, EMAIL_VERIFY_DEFAULT, EMAIL_VERIFY_MIN, EMAIL_VERIFY_MAX),
    normalizeIpKey: true,
    message: 'Too many verification attempts. Please try again later.'
  });

  const publicSignupLimiter = buildIpRateLimiter({
    windowMs: MS_PER_HOUR,
    max: parseRateLimit(process.env.SIGNUP_MAX_PER_HOUR, SIGNUP_DEFAULT, SIGNUP_MIN, SIGNUP_MAX),
    normalizeIpKey: true,
    message: 'Too many signup attempts. Please try again later.'
  });

  const refreshLimiter = buildIpRateLimiter({
    windowMs: MINUTES_PER_WINDOW_15 * MS_PER_MINUTE,
    max: parseRateLimit(process.env.AUTH_REFRESH_MAX_PER_15M, REFRESH_DEFAULT, REFRESH_MIN, REFRESH_MAX),
    normalizeIpKey: true,
    message: 'Too many session renewals. Please try again later.'
  });

  /** Vincular código/rotas de referral — bucket por IP + utilizador autenticado. */
  const referralClaimSensitiveLimiter = buildIpRateLimiter({
    windowMs: MINUTES_PER_WINDOW_15 * MS_PER_MINUTE,
    max: parseRateLimit(process.env.REFERRAL_CLAIM_MAX_PER_15M, REFERRAL_CLAIM_DEFAULT, REFERRAL_CLAIM_MIN, REFERRAL_CLAIM_MAX),
    extraKeySuffix: (req) => (req.userId != null ? String(req.userId) : 'anon'),
    message: 'Too many referral operations. Please try again later.'
  });

  const profileWalletMutationLimiter = buildIpRateLimiter({
    windowMs: MINUTES_PER_WINDOW_15 * MS_PER_MINUTE,
    max: PROFILE_WALLET_MUTATION_MAX,
    normalizeIpKey: true,
    extraKeySuffix: (req) => (req.userId != null ? String(req.userId) : 'anon'),
    message: 'Too many wallet operations.'
  });

  return {
    authenticateToken,
    isAdmin,
    parseCookies,
    getClientIp,
    bcrypt: authWorkerBcrypt,
    issueJwtAuthCookies,
    revokeJwtRefreshForUser,
    emitMarketWs,
    emailRequestLimiter,
    passwordResetRequestLimiter,
    securePasswordResetLimiter,
    verifyAttemptLimiter,
    emailAddressMaxLength: EMAIL_ADDRESS_MAX_LENGTH,
    publicSignupLimiter,
    refreshLimiter,
    referralClaimSensitiveLimiter,
    profileWalletMutationLimiter,
    imgDir: IMG_DIR,
    uploadsDir: UPLOADS_DIR
  };
}

export type AppDeps = ReturnType<typeof buildAppDeps>;
