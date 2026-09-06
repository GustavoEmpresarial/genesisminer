/**
 * Auditoria admin de fingerprints de dispositivo (login/registo).
 *
 * Migrado de legacy/backend/models/deviceFingerprintModel.ts (só
 * `listDeviceFingerprintLogs` — `sanitizeDeviceFingerprint`/
 * `insertDeviceFingerprintLog` já vivem em `modules/auth/services/device-fingerprint.ts`).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../core/database/prisma.js';

const MAX_LIMIT = 200;
const SEARCH_MAX_LEN = 100;

export type AdminDeviceFingerprintLog = {
  id: string;
  userId: number;
  email: string | null;
  username: string | null;
  eventType: string;
  fingerprintHash: string;
  payloadJson: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
};

/** Lista auditoria de fingerprints (admin), com utilizador associado. */
export async function listDeviceFingerprintLogs(opts: {
  limit: number;
  offset: number;
  eventType?: 'login' | 'register' | null;
  userId?: number | null;
  q?: string | null;
}): Promise<{ rows: AdminDeviceFingerprintLog[]; total: number }> {
  const lim = Math.min(MAX_LIMIT, Math.max(1, opts.limit));
  const off = Math.max(0, opts.offset);

  const and: Prisma.device_fingerprint_logsWhereInput[] = [];

  if (opts.eventType === 'login' || opts.eventType === 'register') {
    and.push({ event_type: opts.eventType });
  }
  if (opts.userId != null && Number.isFinite(opts.userId) && opts.userId > 0) {
    and.push({ user_id: Math.floor(opts.userId) });
  }

  const qRaw = (opts.q ?? '').trim().replace(/%/g, '').replace(/_/g, '').slice(0, SEARCH_MAX_LEN);
  if (qRaw.length > 0) {
    const matchingUsers = await prisma.users.findMany({
      where: { OR: [{ email: { contains: qRaw, mode: 'insensitive' } }, { username: { contains: qRaw, mode: 'insensitive' } }] },
      select: { id: true }
    });
    const ids = matchingUsers.map((u) => u.id);
    and.push({
      OR: [
        { fingerprint_hash: { contains: qRaw, mode: 'insensitive' } },
        { ip: { contains: qRaw, mode: 'insensitive' } },
        ...(ids.length > 0 ? [{ user_id: { in: ids } }] : [])
      ]
    });
  }

  const where: Prisma.device_fingerprint_logsWhereInput = and.length > 0 ? { AND: and } : {};

  const total = await prisma.device_fingerprint_logs.count({ where });

  const logs = await prisma.device_fingerprint_logs.findMany({
    where,
    orderBy: { created_at: 'desc' },
    take: lim,
    skip: off
  });

  const userIds = [...new Set(logs.map((l) => l.user_id))];
  const users = userIds.length > 0 ? await prisma.users.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, username: true } }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  const rows: AdminDeviceFingerprintLog[] = logs.map((l) => {
    const u = byId.get(l.user_id);
    return {
      id: String(l.id),
      userId: l.user_id,
      email: u?.email ?? null,
      username: u?.username ?? null,
      eventType: l.event_type,
      fingerprintHash: l.fingerprint_hash,
      payloadJson: l.payload_json,
      ip: l.ip,
      userAgent: l.user_agent,
      createdAt: Number(l.created_at)
    };
  });

  return { rows, total };
}
