export { registerAdminSuspiciousEmailsModuleRoutes, type AdminSuspiciousEmailsModuleDeps } from './controllers/suspicious-emails.controller.js';
export {
  buildSuspiciousEmailsCsv,
  deactivateFilteredSuspiciousUsers,
  deactivateSuspiciousActiveUserIds,
  fetchSuspiciousEmailsReport,
  resolveSuspiciousUsersWorkingSet,
  type DeactivateFilteredSuspiciousResult,
  type SuspiciousEmailReferrer,
  type SuspiciousEmailUserRow,
  type SuspiciousEmailsListQuery,
  type SuspiciousEmailsReport
} from './services/report.js';
export { calculateUserSuspicionScore, type RiskLevel } from './services/score.js';
export {
  detectSuspiciousEmail,
  getEmailDomain,
  isFakeEmailPattern,
  isInvalidEmailFormat,
  isProviderTypoDomain,
  isSuspiciousDomainHeuristic,
  isTemporaryEmailDomain,
  isTrustedEmailDomain,
  isValidEmailFormat,
  normalizeEmail,
  FAKE_EXACT_EMAILS_LIST,
  SUSPICIOUS_EMAIL_REASON_CODES,
  TRUSTED_EMAIL_DOMAINS,
  type DetectSuspiciousEmailContext,
  type SuspiciousEmailReasonCode
} from './services/detect.js';
export { DISPOSABLE_EMAIL_DOMAINS } from './services/domains.js';
export { deriveActivityReasons, mergeEmailAndActivityReasons, type UserActivitySignals } from './services/signals.js';
