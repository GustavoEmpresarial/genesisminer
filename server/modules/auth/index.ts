/**
 * Módulo `auth`: JWT (access + refresh rotation), cookies, sessão legada `sid`,
 * login e cadastro público.
 *
 * HTTP de login/cadastro/sessão/verificação/reset é de genesis-api; aqui só
 * ficam os serviços reutilizados pelos middlewares admin e pelo bootstrap.
 *
 * Estrutura: `models/` (acesso a dados via Prisma), `services/` (JWT, cookies,
 * validação, e-mail de verificação, etc — tudo que não é acesso a dados puro).
 */
export { getJwtAuthConfig, COOKIE_ACCESS, COOKIE_REFRESH } from './services/config.js';
export type { JwtAuthConfig } from './services/config.js';
export { signAccessToken, verifyAccessToken } from './services/jwt-service.js';
export type { VerifiedAccess, SignedAccessToken } from './services/jwt-service.js';
export {
  createResolveAuthMiddleware,
  readCookie,
  issueJwtAuthCookies,
  handleJwtRefresh,
  revokeJwtRefreshForUser,
  sendAuthUnauthorized,
  createRequireJwtAccessMiddleware,
  createAuthenticateTokenMiddleware
} from './services/http-auth.js';
export type { ParseCookiesFn, ResolveAuthDeps, RequireJwtAccessDeps } from './services/http-auth.js';
export { clearAuthCookies, appendAccessCookie, appendRefreshCookie } from './services/cookies.js';
export { writeJwtRefreshSnapshot, ensureStorageDir } from './services/storage-mirror.js';
export {
  revokeAllRefreshForUser,
  issueRefreshToken,
  rotateRefreshToken
} from './services/refresh-token-store.js';
export type { IssueRefreshArgs, IssuedRefresh, RotateRefreshResult } from './services/refresh-token-store.js';
export { resolveIsSuperAdminFromUserRow } from './services/super-admin.js';
export { generateReferralCode } from './services/referral-code.js';
export {
  validateLoginEmail,
  validateLoginFieldsPresent,
  validateLoginPassword
} from './services/login-validation.js';
export {
  validateSignupUsername,
  validateSignupPassword,
  assertPublicSignupEmailAllowed,
  getConflictingUserIdByEmail,
  getConflictingUserIdByUsername
} from './services/signup-validation.js';
export { validatePasswordStrengthPolicy, validateProfileNewPasswordStrength } from './services/password-policy.js';
export {
  getEmailVerificationFlags,
  userRequiresEmailVerification,
  buildSignedEmailVerificationToken,
  parseSignedEmailVerificationToken,
  markUserPendingEmailVerificationTx,
  sendSignupVerificationEmail,
  resendVerificationEmailIfPending,
  verifyEmailTokenAndActivate
} from './services/email-verification.js';
export type { EmailVerificationFlags } from './services/email-verification.js';
export { sanitizeDeviceFingerprint, insertDeviceFingerprintLog } from './services/device-fingerprint.js';
export { getUserIdByEmail, EmailPolicyError, IpLimitError } from './services/user-creation.js';
export { createIsAdminMiddleware, loadAdminGateContext, isIpFromUser } from './services/admin-guard.js';
export type { AdminGateContext, IsAdminMiddlewareDeps } from './services/admin-guard.js';
export * as authRepository from './models/repository.js';
