/**
 * Pontuação heurística só para priorização visual — não altera contas.
 * Migrado de legacy/backend/modules/admin/suspiciousEmails/suspicionScore.ts (verbatim).
 */
const WEIGHT_INVALID_FORMAT = 50;
const WEIGHT_TEMPORARY_DOMAIN = 60;
const WEIGHT_FAKE_PATTERN = 45;
const WEIGHT_DUPLICATE_EMAIL = 40;
const WEIGHT_DOMAIN_NOT_TRUSTED = 30;
const WEIGHT_REFERRAL_ONLY = 30;
const WEIGHT_NEVER_MINED = 25;
const WEIGHT_NO_GAME_PROGRESS = 20;
const WEIGHT_SUSPICIOUS_DOMAIN = 20;
const WEIGHT_UNVERIFIED_EMAIL = 15;
const WEIGHT_NO_WALLET = 15;
const WEIGHT_NO_DEPOSIT = 15;
const WEIGHT_ZERO_HASH = 10;
const WEIGHT_INACTIVE_ACCOUNT = 10;
const WEIGHT_DEAD_ACCOUNT = 35;

const WEIGHTS: ReadonlyArray<[string, number]> = [
  ['invalid_format', WEIGHT_INVALID_FORMAT],
  ['temporary_domain', WEIGHT_TEMPORARY_DOMAIN],
  ['fake_pattern', WEIGHT_FAKE_PATTERN],
  ['duplicate_email', WEIGHT_DUPLICATE_EMAIL],
  ['domain_not_trusted', WEIGHT_DOMAIN_NOT_TRUSTED],
  ['referral_only', WEIGHT_REFERRAL_ONLY],
  ['never_mined', WEIGHT_NEVER_MINED],
  ['no_game_progress', WEIGHT_NO_GAME_PROGRESS],
  ['suspicious_domain', WEIGHT_SUSPICIOUS_DOMAIN],
  ['unverified_email', WEIGHT_UNVERIFIED_EMAIL],
  ['no_wallet', WEIGHT_NO_WALLET],
  ['no_deposit', WEIGHT_NO_DEPOSIT],
  ['zero_hash', WEIGHT_ZERO_HASH],
  ['inactive_account', WEIGHT_INACTIVE_ACCOUNT],
  ['dead_account', WEIGHT_DEAD_ACCOUNT]
];

const RISK_HIGH_THRESHOLD = 80;
const RISK_MEDIUM_THRESHOLD = 50;
const RISK_LOW_THRESHOLD = 30;

export type RiskLevel = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Soma os pesos das razões presentes (cada razão conta uma única vez, mesmo
 * que apareça repetida no array de entrada) e mapeia o total para um
 * `RiskLevel` por faixa (`high >= 80`, `medium >= 50`, `low >= 30`, senão
 * `minimal`). Só para priorização visual no admin — não decide sozinho
 * nenhuma acção destrutiva (isso é responsabilidade explícita dos filtros em
 * `resolveSuspiciousUsersWorkingSet`/`deactivateFilteredSuspiciousUsers`).
 */
export function calculateUserSuspicionScore(reasons: ReadonlyArray<string>): { score: number; riskLevel: RiskLevel } {
  let score = 0;
  const seen = new Set<string>();
  for (const [code, w] of WEIGHTS) {
    if (!reasons.includes(code) || seen.has(code)) continue;
    seen.add(code);
    score += w;
  }
  const riskLevel: RiskLevel = score >= RISK_HIGH_THRESHOLD ? 'high' : score >= RISK_MEDIUM_THRESHOLD ? 'medium' : score >= RISK_LOW_THRESHOLD ? 'low' : 'minimal';
  return { score, riskLevel };
}
