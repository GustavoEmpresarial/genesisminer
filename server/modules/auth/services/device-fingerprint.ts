/**
 * Sanitização + persistência de fingerprint de dispositivo (login/registro) — só
 * chaves numa allowlist, tamanho limitado, hash SHA-256 pra deduplicação/auditoria.
 *
 * Migrado de legacy/backend/models/deviceFingerprintModel.ts — só
 * `sanitizeDeviceFingerprint` e `insertDeviceFingerprintLog` (usadas no registro).
 * `listDeviceFingerprintLogs` é consulta admin, migra com `modules/admin/`.
 */
import crypto from 'node:crypto';
import { prisma } from '../../../core/database/prisma.js';
import { rustSanitizeFingerprint } from './auth-rust-bridge.js';

const MAX_PAYLOAD_CHARS = 12_000;
const MAX_COMPONENT_STRING_LENGTH = 600;
const VISITOR_ID_MAX_LENGTH = 128;
const IP_MAX_LENGTH = 128;
const USER_AGENT_MAX_LENGTH = 512;

const ALLOW_COMPONENT_KEYS = new Set([
  'userAgent', 'language', 'languages', 'platform', 'hardwareConcurrency', 'deviceMemory',
  'timezone', 'timezoneOffset', 'screenResolution', 'colorDepth', 'pixelRatio', 'touchSupport',
  'cookiesEnabled', 'pdfViewerEnabled', 'localStorage', 'sessionStorage', 'vendor',
  'maxTouchPoints', 'webglVendor', 'webglRenderer'
]);

const VISITOR_ID_PATTERN = /^[a-f0-9]{32,128}$/i;

export type DeviceFingerprintEvent = 'login' | 'register';

export type SanitizedDeviceFingerprint = {
  fingerprintHash: string;
  payloadJson: string;
};

/**
 * Normaliza o payload enviado pelo browser (apenas chaves permitidas, tamanhos limitados)
 * e devolve JSON + hash SHA-256 para deduplicação/auditoria.
 */
export function sanitizeDeviceFingerprint(raw: unknown): SanitizedDeviceFingerprint | null {
  const rust = rustSanitizeFingerprint(raw);
  if (rust !== undefined) {
    return rust == null
      ? null
      : { fingerprintHash: rust.fingerprintHash, payloadJson: rust.payloadJson };
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const safe: Record<string, unknown> = {};

  if (typeof o.visitorId === 'string' && VISITOR_ID_PATTERN.test(o.visitorId)) {
    safe.visitorId = o.visitorId.slice(0, VISITOR_ID_MAX_LENGTH);
  }

  const components = o.components;
  if (components != null && typeof components === 'object' && !Array.isArray(components)) {
    const c = components as Record<string, unknown>;
    for (const key of ALLOW_COMPONENT_KEYS) {
      if (!(key in c)) continue;
      const v = c[key];
      if (typeof v === 'string') {
        if (v.length <= MAX_COMPONENT_STRING_LENGTH) safe[key] = v;
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        safe[key] = v;
      } else if (typeof v === 'boolean') {
        safe[key] = v;
      }
    }
  }

  if (Object.keys(safe).length === 0) return null;

  const payloadJson = JSON.stringify(safe);
  if (payloadJson.length > MAX_PAYLOAD_CHARS) return null;

  const fingerprintHash = crypto.createHash('sha256').update(payloadJson).digest('hex');
  return { fingerprintHash, payloadJson };
}

export async function insertDeviceFingerprintLog(opts: {
  userId: number;
  eventType: DeviceFingerprintEvent;
  fingerprintHash: string;
  payloadJson: string;
  ip: string;
  userAgent: string;
}): Promise<void> {
  if (opts.eventType !== 'login' && opts.eventType !== 'register') return;
  if (!Number.isFinite(opts.userId) || opts.userId < 1) return;
  await prisma.device_fingerprint_logs.create({
    data: {
      user_id: opts.userId,
      event_type: opts.eventType,
      fingerprint_hash: opts.fingerprintHash,
      payload_json: opts.payloadJson,
      ip: opts.ip.slice(0, IP_MAX_LENGTH),
      user_agent: opts.userAgent.slice(0, USER_AGENT_MAX_LENGTH),
      created_at: BigInt(Date.now())
    }
  });
}
