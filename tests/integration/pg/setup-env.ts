/**
 * Carrega `.env` antes dos imports dos testes de integração PG.
 * Usado via `setupFiles` em `vitest.pg-integration.config.ts`.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { assertTestDatabaseUrl } from '../../shared/database/assert-test-database.js';

config({ path: resolve(process.cwd(), '.env') });

if (!process.env.DATABASE_URL?.trim()) {
  process.env.DATABASE_URL = 'postgres://postgres:postgrespassword@127.0.0.1:5432/minestation';
}

assertTestDatabaseUrl(process.env.DATABASE_URL);

/** Garante pool com margem para Promise.all de checkouts concorrentes. */
if (!process.env.PG_POOL_MAX?.trim()) {
  process.env.PG_POOL_MAX = '30';
}

process.env.RUN_PG_INTEGRATION = '1';
