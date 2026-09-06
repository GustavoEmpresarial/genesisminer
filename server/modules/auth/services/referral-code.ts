/**
 * Geração de código de referral a partir do nome de usuário.
 */
import crypto from 'node:crypto';
import { rustGenerateReferralCode } from './auth-rust-bridge.js';

const USERNAME_SLUG_MAX_LENGTH = 12;
const RANDOM_HEX_SUFFIX_LENGTH = 8;
const RANDOM_NUMERIC_SUFFIX_MAX = 100_000;
const RANDOM_NUMERIC_SUFFIX_PAD = 5;

export function generateReferralCode(username: string): string {
  const rust = rustGenerateReferralCode(username || 'user');
  if (rust) return rust;
  const base =
    (username || 'user')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '-')
      .slice(0, USERNAME_SLUG_MAX_LENGTH) || 'user';
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, RANDOM_HEX_SUFFIX_LENGTH);
  const num = Math.floor(Math.random() * RANDOM_NUMERIC_SUFFIX_MAX)
    .toString()
    .padStart(RANDOM_NUMERIC_SUFFIX_PAD, '0');
  return `${base}-${rand}_${num}`;
}
