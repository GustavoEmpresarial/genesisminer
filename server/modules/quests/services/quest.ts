/**
 * Migrado de legacy/backend/modules/quests/quest.service.ts.
 *
 * `ensureQuestSchema()` no legado fazia `CREATE TABLE IF NOT EXISTS` no boot
 * (schema ad-hoc, sem migrations formais). Em `current/`, `quest_definitions`/
 * `user_quest_progress` já existem via migration Prisma — aqui a função só
 * garante a semente (`DEFAULT_QUEST_DEFINITIONS`, idempotente via
 * `ON CONFLICT DO NOTHING`) e actualiza a descrição das tarefas de check-in.
 *
 * Chamada defensivamente em todo entry-point exportado (não só no boot do
 * módulo `quests`) porque `bumpQuestProgress` também é chamado a partir de
 * `modules/checkin`/`modules/merge` — esses módulos não podem depender da
 * ordem de registo das rotas de `quests` ter corrido primeiro. Cacheada em
 * memória após o 1º sucesso pra não repetir os upserts a cada request.
 */
import db from '../../../core/database/pool.js';
import { isPremiumWithinActiveWindow, resolveUserCheckinPremiumContext } from '../../checkin/services/premium-policy.js';
import { callQuestsState } from '../../mining-engine/services/mining-worker-client.js';
import { callWalletQuestClaim } from '../../wallet/services/wallet-worker-client.js';
import { DEFAULT_QUEST_DEFINITIONS, type QuestActionType, type QuestDefinitionRow, type QuestPeriod, type QuestStateItem } from './types.js';
import { questPeriodKey, type QuestPeriodBounds } from './period.js';

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

const REWARD_USDC_DECIMALS = 1e6;
const TARGET_COUNT_MAX = 10000;
const REWARD_USDC_MAX = 1e6;
const TITLE_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 400;
const LOCK_TIMEOUT_MS = 45_000;
const PREMIUM_CHECKIN_MIN_PROGRESS = 1;
const DAILY_CHECKIN_QUEST_ID = 'daily_checkin';


let questSchemaEnsured = false;

export async function ensureQuestSchema(): Promise<void> {
  if (questSchemaEnsured) return;
  const client = await db.connect();
  try {
    const now = Date.now();
    for (const q of DEFAULT_QUEST_DEFINITIONS) {
      await client.query(
        `INSERT INTO quest_definitions (
           id, period, action_type, title, description, target_count, reward_usdc, sort_order, enabled, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO NOTHING`,
        [q.id, q.period, q.action_type, q.title, q.description, q.target_count, q.reward_usdc, q.sort_order, q.enabled, now]
      );
    }
    // Actualiza textos das tarefas de check-in (premium vs diário).
    for (const q of DEFAULT_QUEST_DEFINITIONS.filter((d) => d.action_type === 'checkin')) {
      await client.query(`UPDATE quest_definitions SET description = $2, updated_at = $3 WHERE id = $1 AND description IS DISTINCT FROM $2`, [q.id, q.description, now]);
    }
    questSchemaEnsured = true;
  } finally {
    client.release();
  }
}

/**
 * Check-in premium (intervalo N dias): o jogador não pode fazer check-in todos os dias.
 * Enquanto a janela premium estiver activa, cada ciclo diário (00:00 UTC) conta 1 progresso
 * nas tarefas de check-in (diária + semanal), ao abrir o estado das tarefas.
 *
 * Gate + bump na mesma tx com `FOR UPDATE` no progresso diário — evita corrida de
 * dois `getQuestsState` a creditar a weekly 2× no mesmo dia.
 */
async function ensurePremiumCheckinQuestCredit(userId: number, nowMs: number): Promise<void> {
  if (!Number.isFinite(userId) || userId <= 0) return;
  try {
    const ctx = await resolveUserCheckinPremiumContext(userId);
    if (!ctx.premiumWeeklyCheckin) return;

    const gs = await db.query<{ last_checkin_at_ms: number | string | bigint | null }>(`SELECT last_checkin_at_ms FROM game_states WHERE user_id = $1`, [userId]);
    if (!gs.rowCount) return;
    const raw = gs.rows[0].last_checkin_at_ms;
    const lastAt = raw == null ? null : typeof raw === 'number' ? raw : Number(raw);
    if (lastAt == null || !Number.isFinite(lastAt) || lastAt <= 0) return;
    if (!isPremiumWithinActiveWindow(lastAt, nowMs, ctx.policy.intervalDays)) return;

    const dailyKey = questPeriodKey('daily', nowMs);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
      await client.query(
        `INSERT INTO user_quest_progress (user_id, quest_id, period_key, progress, completed_at, claimed_at, updated_at)
         VALUES ($1, $2, $3, 0, NULL, NULL, $4)
         ON CONFLICT (user_id, quest_id, period_key) DO NOTHING`,
        [userId, DAILY_CHECKIN_QUEST_ID, dailyKey, nowMs]
      );
      const gate = await client.query(
        `SELECT progress FROM user_quest_progress
          WHERE user_id = $1 AND quest_id = $2 AND period_key = $3 FOR UPDATE`,
        [userId, DAILY_CHECKIN_QUEST_ID, dailyKey]
      );
      const already = gate.rowCount ? Math.floor(Number(gate.rows[0].progress) || 0) : 0;
      if (already >= PREMIUM_CHECKIN_MIN_PROGRESS) {
        await client.query('ROLLBACK');
        return;
      }
      await bumpQuestProgress(userId, 'checkin', 1, nowMs, client);
      await client.query('COMMIT');
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.warn('[quests] ensurePremiumCheckinQuestCredit:', e instanceof Error ? e.message : e);
  }
}

async function listEnabledDefinitions(): Promise<QuestDefinitionRow[]> {
  const res = await db.query(
    `SELECT id, period, action_type, title, description, target_count, reward_usdc, sort_order, enabled, updated_at
     FROM quest_definitions
     WHERE enabled = 1
     ORDER BY sort_order ASC, id ASC`
  );
  return res.rows.map(mapDef);
}

function mapDef(r: Record<string, unknown>): QuestDefinitionRow {
  return {
    id: String(r.id),
    period: String(r.period) as QuestPeriod,
    action_type: String(r.action_type) as QuestActionType,
    title: String(r.title || ''),
    description: String(r.description || ''),
    target_count: Math.max(1, Math.floor(num(r.target_count, 1))),
    reward_usdc: Math.max(0, num(r.reward_usdc, 0)),
    sort_order: Math.floor(num(r.sort_order, 0)),
    enabled: Number(r.enabled) === 1 ? 1 : 0,
    updated_at: Math.floor(num(r.updated_at, 0))
  };
}

export async function listAllQuestDefinitionsAdmin(): Promise<QuestDefinitionRow[]> {
  await ensureQuestSchema();
  const res = await db.query(
    `SELECT id, period, action_type, title, description, target_count, reward_usdc, sort_order, enabled, updated_at
     FROM quest_definitions
     ORDER BY sort_order ASC, id ASC`
  );
  return res.rows.map(mapDef);
}

export async function saveQuestDefinitionAdmin(input: {
  id: string;
  title?: string;
  description?: string;
  targetCount?: number;
  rewardUsdc?: number;
  sortOrder?: number;
  enabled?: boolean;
}): Promise<QuestDefinitionRow | null> {
  await ensureQuestSchema();
  const id = String(input.id || '').trim();
  if (!id) return null;
  const now = Date.now();
  const cur = await db.query(`SELECT * FROM quest_definitions WHERE id = $1`, [id]);
  if (cur.rowCount === 0) return null;
  const row = cur.rows[0];
  const title = input.title != null ? String(input.title).trim().slice(0, TITLE_MAX_LENGTH) : String(row.title);
  if (input.title != null && !title) return null;
  const description = input.description != null ? String(input.description).trim().slice(0, DESCRIPTION_MAX_LENGTH) : String(row.description || '');
  const targetCount = input.targetCount != null ? Math.max(1, Math.min(TARGET_COUNT_MAX, Math.floor(Number(input.targetCount) || 1))) : Math.max(1, Math.floor(num(row.target_count, 1)));
  const rewardUsdc =
    input.rewardUsdc != null ? Math.max(0, Math.min(REWARD_USDC_MAX, Math.round(Number(input.rewardUsdc) * REWARD_USDC_DECIMALS) / REWARD_USDC_DECIMALS)) : Math.max(0, num(row.reward_usdc, 0));
  const sortOrder = input.sortOrder != null ? Math.floor(Number(input.sortOrder) || 0) : Math.floor(num(row.sort_order, 0));
  const enabled = input.enabled != null ? (input.enabled ? 1 : 0) : Number(row.enabled) === 1 ? 1 : 0;

  await db.query(
    `UPDATE quest_definitions
        SET title = $2, description = $3, target_count = $4, reward_usdc = $5,
            sort_order = $6, enabled = $7, updated_at = $8
      WHERE id = $1`,
    [id, title, description, targetCount, rewardUsdc, sortOrder, enabled, now]
  );
  const next = await db.query(`SELECT * FROM quest_definitions WHERE id = $1`, [id]);
  return next.rows[0] ? mapDef(next.rows[0]) : null;
}

export async function getQuestsState(
  userId: number,
  nowMs: number = Date.now()
): Promise<{
  daily: QuestStateItem[];
  weekly: QuestStateItem[];
  dailyPeriodKey: string;
  weeklyPeriodKey: string;
  dailyPeriod: QuestPeriodBounds;
  weeklyPeriod: QuestPeriodBounds;
}> {
  const body = await callQuestsState({ userId, nowMs });
  return body as unknown as {
    daily: QuestStateItem[];
    weekly: QuestStateItem[];
    dailyPeriodKey: string;
    weeklyPeriodKey: string;
    dailyPeriod: QuestPeriodBounds;
    weeklyPeriod: QuestPeriodBounds;
  };
}

/**
 * Incrementa progresso de todas as quests activas do `actionType` (daily + weekly).
 * Best-effort: não lança para o caller (hooks de checkin/merge/offerwall).
 * Se `client` for passado, corre na tx do caller (sem BEGIN/COMMIT próprios).
 */
export async function bumpQuestProgress(
  userId: number,
  actionType: QuestActionType,
  amount: number = 1,
  nowMs: number = Date.now(),
  client?: import('pg').PoolClient
): Promise<void> {
  if (!Number.isFinite(userId) || userId <= 0) return;
  const delta = Math.max(0, Math.floor(Number(amount) || 0));
  if (delta <= 0) return;

  try {
    await ensureQuestSchema();
    const defs = await listEnabledDefinitions();
    const matched = defs.filter((d) => d.action_type === actionType);
    if (matched.length === 0) return;

    const ownClient = !client;
    const c = client ?? (await db.connect());
    try {
      if (ownClient) {
        await c.query('BEGIN');
        await c.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
      }
      for (const d of matched) {
        const pk = questPeriodKey(d.period, nowMs);
        await c.query(
          `INSERT INTO user_quest_progress (user_id, quest_id, period_key, progress, completed_at, claimed_at, updated_at)
           VALUES ($1, $2, $3, 0, NULL, NULL, $4)
           ON CONFLICT (user_id, quest_id, period_key) DO NOTHING`,
          [userId, d.id, pk, nowMs]
        );
        const row = await c.query(
          `SELECT progress, completed_at, claimed_at FROM user_quest_progress
           WHERE user_id = $1 AND quest_id = $2 AND period_key = $3 FOR UPDATE`,
          [userId, d.id, pk]
        );
        if (row.rowCount === 0) continue;
        const cur = Math.max(0, Math.floor(num(row.rows[0].progress, 0)));
        if (row.rows[0].claimed_at != null) continue;
        const next = Math.min(d.target_count, cur + delta);
        const completedAt = next >= d.target_count ? (row.rows[0].completed_at != null ? Math.floor(num(row.rows[0].completed_at)) : nowMs) : null;
        await c.query(
          `UPDATE user_quest_progress
              SET progress = $4, completed_at = $5, updated_at = $6
            WHERE user_id = $1 AND quest_id = $2 AND period_key = $3`,
          [userId, d.id, pk, next, completedAt, nowMs]
        );
      }
      if (ownClient) await c.query('COMMIT');
    } catch (e) {
      if (ownClient) {
        try {
          await c.query('ROLLBACK');
        } catch {
          /* ignore */
        }
      }
      throw e;
    } finally {
      if (ownClient) c.release();
    }
  } catch (e) {
    // Com client externo a falha deve propagar (caller faz ROLLBACK).
    if (client) throw e;
    console.warn('[quests] bumpQuestProgress:', e instanceof Error ? e.message : e);
  }
}

export async function claimQuestReward(
  userId: number,
  questId: string,
  nowMs: number = Date.now()
): Promise<{ ok: true; rewardUsdc: number; newUsdc: number } | { ok: false; error: string; code: string }> {
  await ensureQuestSchema();
  await ensurePremiumCheckinQuestCredit(userId, nowMs);
  const id = String(questId || '').trim();
  if (!id) return { ok: false, error: 'Invalid quest.', code: 'BAD_QUEST' };

  return callWalletQuestClaim({ userId, questId: id, serverNowMs: nowMs });
}
