import { describe, expect, it } from 'vitest';
import {
  PROD_DATABASE_HOST_DOMAIN,
  PROD_DATABASE_HOST_IP,
  assertTestDatabaseUrl
} from './assert-test-database.js';

const PG_USER = 'postgres';
const PG_PASS = 'postgrespassword';
const PG_PORT = 5432;
const PG_DB = 'minestation';

function pgUrl(host: string): string {
  return `postgres://${PG_USER}:${PG_PASS}@${host}:${PG_PORT}/${PG_DB}`;
}

describe('assertTestDatabaseUrl', () => {
  it('recusa o IP de produção do example de deploy', () => {
    expect(() => assertTestDatabaseUrl(pgUrl(PROD_DATABASE_HOST_IP))).toThrow(/produção/);
  });

  it('recusa o domínio público de produção', () => {
    expect(() => assertTestDatabaseUrl(pgUrl(PROD_DATABASE_HOST_DOMAIN))).toThrow(/produção/);
  });

  it('recusa o domínio de produção sem distinguir maiúsculas', () => {
    expect(() => assertTestDatabaseUrl(pgUrl(PROD_DATABASE_HOST_DOMAIN.toUpperCase()))).toThrow(/produção/);
  });

  it('aceita o fallback local do harness (127.0.0.1 / minestation)', () => {
    expect(() => assertTestDatabaseUrl(pgUrl('127.0.0.1'))).not.toThrow();
  });

  it('aceita localhost', () => {
    expect(() => assertTestDatabaseUrl(pgUrl('localhost'))).not.toThrow();
  });

  it('recusa URL que não é parseável', () => {
    expect(() => assertTestDatabaseUrl('not-a-url')).toThrow(/inválida/);
  });
});
