/**
 * OCC — revisão monotônica do catálogo `upgrades`.
 * Padrão alinhado a STATE_VERSION_CONFLICT (lock row → compare → mutate → bump).
 */
import type { PoolClient } from 'pg';
import pool from '../../../core/database/pool.js';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';

const HTTP_CONFLICT = 409;
const HTTP_BAD_REQUEST = 400;

export const UPGRADES_CATALOG_META_ID = 1;
export const CATALOG_VERSION_CONFLICT = 'CATALOG_VERSION_CONFLICT';

type Queryable = Pick<PoolClient, 'query'>;

async function ensureMetaRow(client: Queryable): Promise<void> {
  await client.query(
    `INSERT INTO upgrades_catalog_meta (id, revision) VALUES ($1, 0)
     ON CONFLICT (id) DO NOTHING`,
    [UPGRADES_CATALOG_META_ID]
  );
}

/** Leitura sem lock (GET). */
export async function readUpgradesCatalogRevision(client?: Queryable): Promise<number> {
  const q = client ?? pool;
  await ensureMetaRow(q);
  const res = await q.query<{ revision: string | number | bigint }>(
    `SELECT revision FROM upgrades_catalog_meta WHERE id = $1`,
    [UPGRADES_CATALOG_META_ID]
  );
  return Number(res.rows[0]?.revision ?? 0);
}

/** Lock da linha singleton + revision actual (FOR UPDATE). */
export async function lockUpgradesCatalogRevision(client: Queryable): Promise<number> {
  await ensureMetaRow(client);
  const res = await client.query<{ revision: string | number | bigint }>(
    `SELECT revision FROM upgrades_catalog_meta WHERE id = $1 FOR UPDATE`,
    [UPGRADES_CATALOG_META_ID]
  );
  return Number(res.rows[0]?.revision ?? 0);
}

/**
 * Compara expected com revision locked.
 * Em mismatch: throw 409 (caller deve ROLLBACK).
 */
export function assertCatalogRevisionMatches(current: number, expected: number): void {
  if (!Number.isFinite(expected) || expected < 0) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, {
      error: 'expectedCatalogRevision inválido.',
      code: 'CATALOG_REVISION_REQUIRED'
    });
  }
  if (current !== expected) {
    throw new HttpControlledError(HTTP_CONFLICT, {
      error: 'Catálogo foi alterado desde a última leitura. Recarregue e tente novamente.',
      code: CATALOG_VERSION_CONFLICT,
      forceReload: true,
      catalogRevision: current,
      expectedCatalogRevision: expected
    });
  }
}

/** Incremento atómico; exige lock prévio (mesma transação). */
export async function bumpUpgradesCatalogRevision(client: Queryable): Promise<number> {
  const res = await client.query<{ revision: string | number | bigint }>(
    `UPDATE upgrades_catalog_meta SET revision = revision + 1 WHERE id = $1 RETURNING revision`,
    [UPGRADES_CATALOG_META_ID]
  );
  return Number(res.rows[0]?.revision ?? 0);
}

export function parseExpectedCatalogRevision(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return Math.floor(Number(raw));
  }
  throw new HttpControlledError(HTTP_BAD_REQUEST, {
    error: 'expectedCatalogRevision obrigatório.',
    code: 'CATALOG_REVISION_REQUIRED'
  });
}
