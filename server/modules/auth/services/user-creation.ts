/**
 * Resolução/criação de usuário por e-mail no cadastro: se já existe, devolve o id
 * (garantindo `referral_code`); se não existe, cria a conta + estado inicial de jogo
 * + caixas de boas-vindas (`loot_boxes` com `trigger = 'registration'`).
 *
 * Migrado de legacy/backend/models/userModel.ts. Mesmo comportamento — **exceto**
 * crédito de referral pra quem indicou, que não estava aqui mesmo no legado (fica em
 * `executeUserPutCoreTransaction`, ver docs/architecture/DECISIONS.md: essa
 * transação mistura cadastro com economia de referral/wallet; não portada por
 * decisão do usuário — `referred_by` é gravado no registro, mas o crédito ao
 * indicador é TODO até `modules/wallet`/`modules/profile` migrarem).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../../core/database/prisma.js';
import { resolveRegistrationIp } from '../../../core/http/client-ip.js';
import { assertPublicSignupEmailAllowed } from './signup-validation.js';
import { generateReferralCode } from './referral-code.js';
import { MS_PER_HOUR } from '../../../shared/utils/time.js';
import { ensureUserHasDefaultAsicRoom } from '../../rooms/services/grant-default-asic-room.js';

export type GetUserIdOpts = { allowAnyDomain?: boolean; preferredUsername?: string | null };

export class EmailPolicyError extends Error {
  readonly code = 'EMAIL_POLICY' as const;
  constructor(message: string) {
    super(message);
    this.name = 'EmailPolicyError';
  }
}

export class IpLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpLimitError';
  }
}

const REFERRAL_CODE_CLASH_RETRY_MAX = 10;

async function generateUniqueReferralCode(usernameSeed: string): Promise<string> {
  let code = generateReferralCode(usernameSeed);
  let tries = 0;
  while (tries < REFERRAL_CODE_CLASH_RETRY_MAX) {
    const clash = await prisma.users.findFirst({ where: { referral_code: code }, select: { id: true } });
    if (!clash) break;
    code = generateReferralCode(usernameSeed);
    tries++;
  }
  return code;
}

const IP_SIGNUP_LIMIT_WINDOW_DAYS = 90;
const HOURS_PER_DAY = 24;
const IP_SIGNUP_LIMIT_WINDOW_MS = IP_SIGNUP_LIMIT_WINDOW_DAYS * HOURS_PER_DAY * MS_PER_HOUR;
const IP_SIGNUP_LIMIT_MAX_ACCOUNTS = 3;

/**
 * Conta quantas contas foram CRIADAS a partir de `ip` dentro da janela
 * `[windowStart, agora]` — usado pelo limite antifraude de cadastro por IP.
 *
 * Correção de um bug real (achado em revisão de segurança do módulo auth,
 * ver DECISIONS.md): a versão anterior filtrava por `users.last_active_at`,
 * um campo que só é preenchido quando o utilizador se autentica depois do
 * registo — nada no sistema o grava no momento do cadastro. Uma conta criada
 * e nunca usada ficava com `last_active_at = null`, e `{ gte: windowStart }`
 * nunca confere `null`; na prática o limite nunca pegava o padrão de abuso
 * mais óbvio (criar várias contas do mesmo IP e nunca mais tocar nelas).
 *
 * Esta versão usa `game_states.start_time` como proxy de "quando a conta foi
 * criada" — é gravado de forma síncrona e imutável na mesma transação lógica
 * do registo (ver `getUserIdByEmail` mais abaixo), e já é o campo usado em
 * outros lugares do projeto pra "data de criação da conta" (ex.:
 * `modules/admin/user-audit`, `modules/admin/support`). Sem `@relation` no
 * schema (decisão documentada em `prisma/schema.prisma`), por isso `JOIN`
 * explícito em SQL em vez de relação Prisma.
 */
async function countRecentSignupsFromIp(ip: string, windowStart: bigint): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint | number | string }>>`
    SELECT COUNT(*)::bigint AS count
      FROM users u
      JOIN game_states gs ON gs.user_id = u.id
     WHERE u.registration_ip = ${ip}
       AND gs.start_time >= ${windowStart}
  `;
  const c = rows[0]?.count;
  return c == null ? 0 : Number(c);
}

export async function getUserIdByEmail(
  email: string,
  ip: string | null = null,
  opts: GetUserIdOpts = {}
): Promise<string | number> {
  if (!email) throw new Error('Email is required for getUserIdByEmail');
  const normalizedEmail = email.toLowerCase();
  const allowAnyDomain = !!opts.allowAnyDomain;
  const preferred =
    typeof opts.preferredUsername === 'string' && opts.preferredUsername.trim().length > 0
      ? opts.preferredUsername.trim()
      : null;

  const row = await prisma.users.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    select: { id: true, username: true, referral_code: true }
  });

  if (row) {
    if (!row.referral_code) {
      const code = await generateUniqueReferralCode(row.username);
      await prisma.users.update({ where: { id: row.id }, data: { referral_code: code } });
    }
    return row.id;
  }

  const username = preferred || (email.split('@')[0] || 'user');
  const code = await generateUniqueReferralCode(username);

  try {
    if (!allowAnyDomain) {
      const policy = assertPublicSignupEmailAllowed(normalizedEmail);
      if (!policy.ok) {
        throw new EmailPolicyError(policy.error);
      }
    }
    const registrationIp = resolveRegistrationIp(ip);
    if (registrationIp) {
      // Janela temporal (não permanente) — impede que IPs antigos fiquem bloqueados para sempre.
      const windowStart = BigInt(Date.now() - IP_SIGNUP_LIMIT_WINDOW_MS);
      const count = await countRecentSignupsFromIp(registrationIp, windowStart);
      if (count >= IP_SIGNUP_LIMIT_MAX_ACCOUNTS) {
        throw new IpLimitError('Não foi possível concluir o cadastro a partir desta ligação. Tente novamente mais tarde.');
      }
    }

    const created = await prisma.users.create({
      data: {
        username,
        email: normalizedEmail,
        referral_code: code,
        is_admin: 0,
        is_blocked: 0,
        registration_ip: registrationIp
      },
      select: { id: true }
    });
    const newUid = created.id;
    const nowBig = BigInt(Date.now());

    if (registrationIp) {
      await prisma.user_history_ips.createMany({
        data: [{ user_id: newUid, ip: registrationIp, last_used_at: nowBig }],
        skipDuplicates: true
      });
    }

    const regBoxes = await prisma.loot_boxes.findMany({
      where: { trigger: 'registration' },
      select: { id: true }
    });
    const WELCOME_BOX_QTY = 1;
    for (const box of regBoxes) {
      await prisma.unopened_boxes.upsert({
        where: { user_id_box_id: { user_id: newUid, box_id: box.id } },
        create: { user_id: newUid, box_id: box.id, qty: WELCOME_BOX_QTY },
        update: { qty: { increment: WELCOME_BOX_QTY } }
      });
      await prisma.player_claimed_boxes.createMany({
        data: [{ user_id: newUid, box_id: box.id, claimed_at: nowBig }],
        skipDuplicates: true
      });
    }

    try {
      await prisma.game_states.create({
        data: {
          user_id: newUid,
          usdc: 0,
          start_time: nowBig,
          last_updated_at: nowBig,
          claimed_referrals: 0,
          referral_bonus_claimed: 0,
          black_market_balance: 0
        }
      });
    } catch (gsErr: unknown) {
      if (gsErr instanceof Prisma.PrismaClientKnownRequestError && gsErr.code === 'P2002') {
        // já existe (equivalente a ON CONFLICT DO NOTHING)
      } else {
        console.error('Failed to create game state:', gsErr);
      }
    }

    await ensureUserHasDefaultAsicRoom(newUid);

    return newUid;
  } catch (err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const retry = await prisma.users.findFirst({
        where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
        select: { id: true }
      });
      if (retry) return retry.id;
    }
    throw err;
  }
}
