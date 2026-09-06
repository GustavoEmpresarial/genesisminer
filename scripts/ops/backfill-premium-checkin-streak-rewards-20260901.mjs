/**
 * Ops: credita máquinas de sequência de check-in premium em falta (bug até 2026-09-01).
 *
 * Idempotência: settings.ops_backfill_premium_streak_20260901 → { "<userId>": { grantedStreaks: [7,…] } }
 *
 * Uso (na VM, dentro do contentor):
 *   node scripts/ops/backfill-premium-checkin-streak-rewards-20260901.mjs --dry-run
 *   node scripts/ops/backfill-premium-checkin-streak-rewards-20260901.mjs --apply
 */
import pool from '../../dist/core/database/pool.js';
import { loadCheckinPremiumPolicy } from '../../dist/modules/checkin/services/premium-policy.js';
import { loadCheckinRewardPolicy } from '../../dist/modules/checkin/services/reward-policy.js';
import {
  CHECKIN_REWARD_EVERY_DAYS,
  grantCheckinStreakTemporaryItem
} from '../../dist/modules/checkin/services/reward.js';

const BACKFILL_SETTINGS_KEY = 'ops_backfill_premium_streak_20260901';
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const dryRun = !apply || args.has('--dry-run');

if (args.has('--help') || args.has('-h')) {
  console.log('Usage: node scripts/ops/backfill-premium-checkin-streak-rewards-20260901.mjs [--dry-run|--apply]');
  process.exit(0);
}

function parseBackfillState(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function loadBackfillState(client) {
  const res = await client.query(`SELECT value FROM settings WHERE key = $1 LIMIT 1`, [BACKFILL_SETTINGS_KEY]);
  return parseBackfillState(res.rows[0]?.value);
}

async function saveBackfillState(client, state) {
  await client.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [BACKFILL_SETTINGS_KEY, JSON.stringify(state)]
  );
}

async function findPremiumMilestones(client, minUsdc) {
  const res = await client.query(
    `WITH premium_users AS (
       SELECT DISTINCT p.user_id
       FROM admin_upgrade_purchases p
       INNER JOIN admin_upgrades u ON u.id = p.upgrade_id
       WHERE u.price_usdc >= $1
     )
     SELECT
       e.user_id,
       (e.payload->>'streak')::int AS streak,
       e.at_ms
     FROM mining_eligibility_events e
     INNER JOIN premium_users pu ON pu.user_id = e.user_id
     WHERE e.event_type = 'CHECKIN_RECORDED'
       AND COALESCE(e.payload->>'mode', '') = 'premium'
       AND (e.payload->>'streak') ~ '^[0-9]+$'
       AND ((e.payload->>'streak')::int % $2) = 0
       AND (e.payload->>'streak')::int > 0
     ORDER BY e.user_id, e.at_ms`,
    [minUsdc, CHECKIN_REWARD_EVERY_DAYS]
  );
  return res.rows.map((r) => ({
    userId: Number(r.user_id),
    streak: Number(r.streak),
    atMs: Number(r.at_ms)
  }));
}

function groupMilestones(rows) {
  /** @type {Map<number, { streaks: number[], atByStreak: Map<number, number> }>} */
  const byUser = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.userId) || row.userId <= 0) continue;
    if (!Number.isFinite(row.streak) || row.streak <= 0) continue;
    let entry = byUser.get(row.userId);
    if (!entry) {
      entry = { streaks: [], atByStreak: new Map() };
      byUser.set(row.userId, entry);
    }
    if (!entry.atByStreak.has(row.streak)) {
      entry.streaks.push(row.streak);
      entry.atByStreak.set(row.streak, row.atMs);
    }
  }
  return byUser;
}

const nowMs = Date.now();
const premiumPolicy = await loadCheckinPremiumPolicy();
const rewardPolicy = await loadCheckinRewardPolicy();

if (!rewardPolicy.streakRewardEnabled) {
  console.error('[backfill] checkin_streak_reward_enabled está desligado — activa no admin antes de aplicar.');
  if (apply) process.exit(1);
}

const client = await pool.connect();
const report = {
  phase: dryRun && !apply ? 'dry-run' : apply ? 'apply' : 'dry-run',
  streakRewardEnabled: rewardPolicy.streakRewardEnabled,
  streakRewardItemId: rewardPolicy.streakRewardItemId,
  premiumMinUsdc: premiumPolicy.minUsdc,
  users: /** @type {Array<Record<string, unknown>>} */ ([]),
  grantsPlanned: 0,
  grantsApplied: 0,
  errors: /** @type {Array<Record<string, unknown>>} */ ([])
};

try {
  const milestones = await findPremiumMilestones(client, premiumPolicy.minUsdc);
  const grouped = groupMilestones(milestones);
  let backfillState = await loadBackfillState(client);

  for (const [userId, { streaks }] of grouped) {
    const userKey = String(userId);
    const userState = backfillState[userKey] && typeof backfillState[userKey] === 'object'
      ? backfillState[userKey]
      : { grantedStreaks: [] };
    const granted = new Set(
      Array.isArray(userState.grantedStreaks)
        ? userState.grantedStreaks.map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0)
        : []
    );
    const pending = streaks.filter((s) => !granted.has(s));
    if (pending.length === 0) continue;

    report.grantsPlanned += pending.length;
    const userReport = { userId, pendingStreaks: pending, applied: [] };
    report.users.push(userReport);

    if (!apply || dryRun) continue;
    if (!rewardPolicy.streakRewardEnabled) continue;

    for (const streak of pending) {
      await client.query('BEGIN');
      try {
        const grant = await grantCheckinStreakTemporaryItem(client, userId, rewardPolicy, nowMs);
        if (!grant.granted) {
          throw new Error(`grantCheckinStreakTemporaryItem returned 0 for streak ${streak}`);
        }
        granted.add(streak);
        backfillState = {
          ...backfillState,
          [userKey]: { grantedStreaks: [...granted].sort((a, b) => a - b) }
        };
        await saveBackfillState(client, backfillState);
        await client.query('COMMIT');
        report.grantsApplied += 1;
        userReport.applied.push({ streak, itemId: grant.itemId, expiresAtMs: grant.expiresAtMs });
      } catch (e) {
        await client.query('ROLLBACK');
        report.errors.push({
          userId,
          streak,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }
  }

  console.log(JSON.stringify(report, null, 2));
} finally {
  client.release();
  await pool.end();
}

process.exit(report.errors.length > 0 ? 1 : 0);
