/**
 * Economia de referral: registo do vínculo (`referrals`) + crédito em USDC ao
 * indicador na confirmação de e-mail do indicado.
 *
 * Migrado de legacy/backend/models/userPutCoreTransaction.ts (`executeUserPutCoreTransaction`
 * — só a parte de referral, o resto — troca de username/email/wallet/access-level —
 * já é feito directo em cada chamador) + legacy/backend/modules/email-verification/emailVerification.service.ts
 * (o crédito em si, disparado na confirmação, não no registo).
 *
 * Usada por 2 pontos de "vínculo" (criam a linha em `referrals` + contam
 * `claimed_referrals` pro indicador, sem pagar ainda):
 *   - `POST /api/register` em genesis-api (registo com `referredBy`)
 *   - `modules/profile/services/referral-bind.ts` (vincular depois, via perfil)
 * e 1 ponto de "pagamento" (só quando o indicado confirma o e-mail):
 *   - `modules/auth/services/email-verification.ts` → `genesis-wallet`
 *     `POST /v1/wallet/referral/credit-on-email-verified` (fail-closed).
 *
 * ⚠️ Diferença vs. legado: `referrals(user_id, referred_username)` não tem
 * `@@unique` declarada no schema Prisma de `current/` (o legado confiava numa
 * constraint da BD real — `catch` de `P2002` — não confirmável aqui sem migrar
 * o schema). Idempotência: `pg_advisory_xact_lock` no par (referrer, username)
 * + `findFirst` antes do `create`, dentro da mesma transação.
 */
import { Prisma } from '@prisma/client';
import { callWalletReferralCreditOnEmailVerified } from '../../wallet/services/wallet-worker-client.js';

const REFERRAL_BONUS_NOT_CLAIMED = 0;

/**
 * Regista o vínculo de referral: insere `referrals` (idempotente) e soma 1 em
 * `claimed_referrals` do indicador — só a contagem, o USDC só entra depois,
 * na confirmação de e-mail (`creditReferralBonusOnEmailVerified`).
 *
 * Chamar dentro da mesma transação que grava `users.referred_by` no indicado
 * — os 2 devem confirmar/reverter juntos.
 */
export async function bindReferralAndAccrueClaim(tx: Prisma.TransactionClient, params: { referrerId: number; referredUsername: string }): Promise<void> {
  const { referrerId, referredUsername } = params;
  if (!Number.isFinite(referrerId) || referrerId <= 0 || !referredUsername.trim()) return;

  /**
   * Sem @@unique em referrals(user_id, referred_username): findFirst→create
   * permite corrida que duplica claimed_referrals. Advisory lock serializa
   * o par (referrer, username) dentro desta transação.
   */
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${'referral_bind'}), hashtext(${`${referrerId}:${referredUsername}`}))
  `;

  const existing = await tx.referrals.findFirst({ where: { user_id: referrerId, referred_username: referredUsername } });
  if (existing) return;

  await tx.referrals.create({ data: { user_id: referrerId, referred_username: referredUsername } });

  const now = BigInt(Date.now());
  await tx.game_states.upsert({
    where: { user_id: referrerId },
    update: { claimed_referrals: { increment: 1 }, last_updated_at: now },
    create: {
      user_id: referrerId,
      usdc: 0,
      start_time: now,
      last_updated_at: now,
      claimed_referrals: 1,
      referral_bonus_claimed: REFERRAL_BONUS_NOT_CLAIMED,
      black_market_balance: 0
    }
  });
}

/**
 * Paga o indicador em USDC quando o indicado confirma o e-mail — só uma vez
 * por indicado (`game_states.referral_bonus_claimed`), só se o vínculo em
 * `referrals` existir de facto (criado por `bindReferralAndAccrueClaim`).
 *
 * Fail-closed via `genesis-wallet` (idempotent). Call after marking
 * `users.email_verified = 1` (and also on already-verified retry).
 */
export async function creditReferralBonusOnEmailVerified(verifiedUserId: number): Promise<void> {
  await callWalletReferralCreditOnEmailVerified({
    verifiedUserId,
    serverNowMs: Date.now()
  });
}
