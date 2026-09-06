#!/usr/bin/env node
/**
 * 4D.2-close — auditoria de cobertura cutover (read-only).
 *
 * Mede quantas identidades equipadas AGORA não têm MINER_EQUIPPED pós-cutover
 * (= candidatos a complete=false via PRE_CUTOVER_STATE_UNKNOWN).
 *
 * Uso:
 *   node scripts/audit-eligibility-cutover-coverage.mjs
 *   MINING_ELIGIBILITY_HISTORY_CUTOVER_MS=... node scripts/audit-eligibility-cutover-coverage.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function loadDotEnv() {
  const p = resolve(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null) process.env[k] = v;
  }
}

loadDotEnv();

const CUTOVER_DEFAULT = Date.UTC(2026, 7, 21, 12, 0, 0, 0);

function cutoverMs() {
  const raw = process.env.MINING_ELIGIBILITY_HISTORY_CUTOVER_MS;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(String(raw).trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return CUTOVER_DEFAULT;
}

async function main() {
  const cutover = cutoverMs();
  const pool = new pg.Pool(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.PGHOST || '127.0.0.1',
          port: Number(process.env.PGPORT || 5432),
          user: process.env.PGUSER || 'postgres',
          password: process.env.PGPASSWORD || '',
          database: process.env.PGDATABASE || 'postgres'
        }
  );

  try {
    const now = Date.now();
    const [{ rows: meta }] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM mining_eligibility_events`),
    ]);

    const eventStats = await pool.query(
      `SELECT
         COUNT(*)::int AS total_events,
         COUNT(DISTINCT user_id)::int AS users_with_events,
         MIN(at_ms)::bigint AS min_at,
         MAX(at_ms)::bigint AS max_at,
         COUNT(*) FILTER (WHERE at_ms < $1)::int AS before_cutover,
         COUNT(*) FILTER (WHERE at_ms >= $1)::int AS after_cutover,
         COUNT(*) FILTER (WHERE event_type = 'MINER_EQUIPPED' AND at_ms >= $1)::int AS equip_after,
         COUNT(*) FILTER (WHERE event_type = 'MINER_UNEQUIPPED' AND at_ms >= $1)::int AS unequip_after
       FROM mining_eligibility_events`,
      [cutover]
    );

    const byType = await pool.query(
      `SELECT event_type, COUNT(*)::int AS n
         FROM mining_eligibility_events
        WHERE at_ms >= $1
        GROUP BY event_type
        ORDER BY n DESC`,
      [cutover]
    );

    const equipped = await pool.query(
      `SELECT
         pr.user_id,
         s.rack_id,
         s.slot_index,
         NULLIF(BTRIM(s.machine_item_id::text), '') AS item_id,
         s.machine_lease_id::text AS lease_id
       FROM rack_slots s
       INNER JOIN placed_racks pr ON pr.id = s.rack_id
      WHERE s.machine_item_id IS NOT NULL
        AND BTRIM(s.machine_item_id::text) <> ''`
    );

    const equipEvents = await pool.query(
      `SELECT user_id,
              lease_id::text AS lease_id,
              rack_id,
              slot_index,
              catalog_item_id
         FROM mining_eligibility_events
        WHERE event_type = 'MINER_EQUIPPED'
          AND at_ms >= $1
        ORDER BY at_ms ASC, id ASC`,
      [cutover]
    );

    /** @type {Map<number, Set<string>>} */
    const leaseEquippedByUser = new Map();
    /** @type {Map<number, Set<string>>} */
    const placementEquippedByUser = new Map();
    for (const r of equipEvents.rows) {
      const uid = Number(r.user_id);
      if (!leaseEquippedByUser.has(uid)) leaseEquippedByUser.set(uid, new Set());
      if (!placementEquippedByUser.has(uid)) placementEquippedByUser.set(uid, new Set());
      const leaseId = r.lease_id != null ? String(r.lease_id).trim() : '';
      if (leaseId) leaseEquippedByUser.get(uid).add(leaseId);
      else {
        placementEquippedByUser
          .get(uid)
          .add(`${String(r.rack_id)}:${Number(r.slot_index)}:${String(r.catalog_item_id || '')}`);
      }
    }

    const gaps = [];
    const usersWithEquip = new Set();
    const usersWithGap = new Set();

    for (const row of equipped.rows) {
      const uid = Number(row.user_id);
      usersWithEquip.add(uid);
      const leaseId = row.lease_id != null ? String(row.lease_id).trim() : '';
      const itemId = row.item_id != null ? String(row.item_id).trim() : '';
      let covered = false;
      if (leaseId) {
        covered = leaseEquippedByUser.get(uid)?.has(leaseId) === true;
      } else if (itemId) {
        const key = `${String(row.rack_id)}:${Number(row.slot_index)}:${itemId}`;
        covered = placementEquippedByUser.get(uid)?.has(key) === true;
      }
      if (!covered) {
        usersWithGap.add(uid);
        gaps.push({
          user_id: uid,
          rack_id: String(row.rack_id),
          slot_index: Number(row.slot_index),
          lease_id: leaseId || null,
          item_id: itemId || null
        });
      }
    }

    // Utilizadores com racks colocados (universo potencial de reconstrução)
    const usersWithRacks = await pool.query(
      `SELECT COUNT(DISTINCT user_id)::int AS n FROM placed_racks`
    );

    // Dívida “naturalmente fechável”? slots com gap cujo user já tem QUALQUER MINER_EQUIPPED pós-cutover
    // (activo mas identidade sem evento) vs users sem nenhum evento de equip.
    let gapsUsersWithSomeEquipEvent = 0;
    let gapsUsersWithZeroEquipEvent = 0;
    for (const uid of usersWithGap) {
      if ((leaseEquippedByUser.get(uid)?.size || 0) + (placementEquippedByUser.get(uid)?.size || 0) > 0) {
        gapsUsersWithSomeEquipEvent += 1;
      } else {
        gapsUsersWithZeroEquipEvent += 1;
      }
    }

    const es = eventStats.rows[0];
    const report = {
      stamp: '4D.2-close cutover coverage audit',
      cutover_ms: cutover,
      cutover_iso: new Date(cutover).toISOString(),
      now_ms: now,
      now_iso: new Date(now).toISOString(),
      event_log: {
        total_rows: Number(es.total_events),
        users_with_events: Number(es.users_with_events),
        before_cutover: Number(es.before_cutover),
        after_cutover: Number(es.after_cutover),
        miner_equipped_after: Number(es.equip_after),
        miner_unequipped_after: Number(es.unequip_after),
        min_at_ms: es.min_at != null ? Number(es.min_at) : null,
        max_at_ms: es.max_at != null ? Number(es.max_at) : null,
        by_type_after_cutover: byType.rows.map((r) => ({ type: r.event_type, n: Number(r.n) }))
      },
      operational_equipped: {
        slots: equipped.rows.length,
        users: usersWithEquip.size,
        users_with_placed_racks: Number(usersWithRacks.rows[0].n)
      },
      coverage_probe: {
        /** slots equipados sem MINER_EQUIPPED pós-cutover → complete=false */
        incomplete_slots: gaps.length,
        incomplete_users: usersWithGap.size,
        covered_slots: equipped.rows.length - gaps.length,
        incomplete_slot_ratio:
          equipped.rows.length === 0 ? 0 : Number((gaps.length / equipped.rows.length).toFixed(4)),
        incomplete_users_with_some_post_cutover_equip: gapsUsersWithSomeEquipEvent,
        incomplete_users_with_zero_post_cutover_equip: gapsUsersWithZeroEquipEvent,
        sample_gaps: gaps.slice(0, 25)
      },
      interpretation: {
        note:
          'incomplete_* mirrors 4D.2 probePreCutoverCoverage (equipped now, no MINER_EQUIPPED after cutover). Does not invent cutover snapshot.',
        if_incomplete_ratio_high:
          'Opção B (bootstrap factual @ CUTOVER) or hybrid may be needed for full historical windows.',
        if_incomplete_ratio_low_or_falling:
          'Opção A (accept complete=false) may be enough; debt shrinks as users re-equip post-cutover.'
      }
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2));
  process.exit(1);
});
