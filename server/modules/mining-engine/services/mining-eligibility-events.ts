/**
 * Persistência append-only de factos económicos de elegibilidade (TAREFA 4C).
 * Não altera o cálculo de crédito — só memória histórica pós-cutover.
 */
import type { PoolClient } from 'pg';
import { miningEligibilityHistoryCutoverMs } from './mining-eligibility-cutover.js';

export const MINING_ELIGIBILITY_EVENT_TYPES = [
  'MINER_EQUIPPED',
  'MINER_UNEQUIPPED',
  'RACK_POWER_CHANGED',
  'RACK_COIN_CHANGED',
  'ASIC_EXPIRED',
  'RACK_WIRING_CHANGED',
  'RACK_BATTERY_CHANGED',
  'RACK_MULTIPLIER_CHANGED',
  'CHECKIN_RECORDED'
] as const;

export type MiningEligibilityEventType = (typeof MINING_ELIGIBILITY_EVENT_TYPES)[number];

export type MiningEligibilityIdentityKind = 'lease' | 'placement' | 'rack' | 'user';

export type RecordMiningEligibilityEventInput = {
  userId: number;
  eventType: MiningEligibilityEventType;
  atMs: number;
  identityKind: MiningEligibilityIdentityKind;
  leaseId?: string | null;
  rackId?: string | null;
  slotIndex?: number | null;
  catalogItemId?: string | null;
  coinId?: string | null;
  payload?: Record<string, unknown> | null;
};

const EVENT_TYPE_SET = new Set<string>(MINING_ELIGIBILITY_EVENT_TYPES);

export function isMiningEligibilityEventType(v: unknown): v is MiningEligibilityEventType {
  return typeof v === 'string' && EVENT_TYPE_SET.has(v);
}

/**
 * Grava um evento. Falha se a escrita falhar (caller deve estar em TX com a mutação).
 * Eventos com at_ms < cutover ainda são aceites (não bloqueia) mas a política de
 * reconstrução 4D só deve confiar em at_ms >= cutover.
 */
export async function recordMiningEligibilityEvent(
  client: PoolClient,
  input: RecordMiningEligibilityEventInput
): Promise<{ id: string } | { skipped: 'invalid' } | { skipped: 'duplicate_expired' }> {
  const userId = Math.floor(Number(input.userId));
  if (!Number.isFinite(userId) || userId <= 0) return { skipped: 'invalid' };
  if (!isMiningEligibilityEventType(input.eventType)) return { skipped: 'invalid' };

  const atMs = Math.floor(Number(input.atMs));
  if (!Number.isFinite(atMs) || atMs <= 0) return { skipped: 'invalid' };

  const identityKind = String(input.identityKind || '').trim();
  if (
    identityKind !== 'lease' &&
    identityKind !== 'placement' &&
    identityKind !== 'rack' &&
    identityKind !== 'user'
  ) {
    return { skipped: 'invalid' };
  }

  const leaseId = input.leaseId != null && String(input.leaseId).trim() ? String(input.leaseId).trim() : null;
  const rackId = input.rackId != null && String(input.rackId).trim() ? String(input.rackId).trim().slice(0, 120) : null;
  const catalogItemId =
    input.catalogItemId != null && String(input.catalogItemId).trim()
      ? String(input.catalogItemId).trim().slice(0, 200)
      : null;
  const coinId = input.coinId != null && String(input.coinId).trim() ? String(input.coinId).trim().slice(0, 120) : null;
  const slotIndex =
    input.slotIndex != null && Number.isFinite(Number(input.slotIndex)) ? Math.floor(Number(input.slotIndex)) : null;

  let payloadJson: string | null = null;
  if (input.payload && typeof input.payload === 'object') {
    try {
      payloadJson = JSON.stringify({
        ...input.payload,
        cutoverMs: miningEligibilityHistoryCutoverMs()
      });
    } catch {
      payloadJson = null;
    }
  }

  const createdAt = Date.now();

  try {
    const r = await client.query<{ id: string }>(
      `INSERT INTO mining_eligibility_events (
         user_id, event_type, at_ms, identity_kind, lease_id, rack_id, slot_index,
         catalog_item_id, coin_id, payload, created_at
       ) VALUES ($1, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10::jsonb, $11)
       RETURNING id::text AS id`,
      [
        userId,
        input.eventType,
        atMs,
        identityKind,
        leaseId,
        rackId,
        slotIndex,
        catalogItemId,
        coinId,
        payloadJson,
        createdAt
      ]
    );
    const id = r.rows[0]?.id;
    return id ? { id } : { skipped: 'invalid' };
  } catch (e: unknown) {
    const code = e && typeof e === 'object' && 'code' in e ? String((e as { code?: string }).code) : '';
    // Unique parcial ASIC_EXPIRED por lease — retry / double expire
    if (code === '23505' && input.eventType === 'ASIC_EXPIRED') {
      return { skipped: 'duplicate_expired' };
    }
    throw e;
  }
}
