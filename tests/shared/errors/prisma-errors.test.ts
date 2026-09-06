import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { mapPrismaClientError, sendIfPrismaHttpError } from '../../../server/shared/errors/prisma-errors.js';

function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: '6.19.0' });
}

function fakeRes() {
  const res: { statusCode?: number; body?: unknown; headersSent: boolean; status: (n: number) => any; json: (b: unknown) => any } =
    {
      headersSent: false,
      status(n: number) {
        res.statusCode = n;
        return res;
      },
      json(b: unknown) {
        res.body = b;
        return res;
      }
    };
  return res;
}

describe('mapPrismaClientError', () => {
  it('mapeia P2002 (duplicata) para 409', () => {
    const mapped = mapPrismaClientError(knownError('P2002'));
    expect(mapped).toEqual({ status: 409, body: { error: expect.any(String), code: 'DUPLICATE' } });
  });

  it('mapeia P2025 (não encontrado) para 404', () => {
    expect(mapPrismaClientError(knownError('P2025'))?.status).toBe(404);
  });

  it('mapeia P2003 (FK) para 400', () => {
    expect(mapPrismaClientError(knownError('P2003'))?.status).toBe(400);
  });

  it('mapeia P2024 (timeout) para 503', () => {
    expect(mapPrismaClientError(knownError('P2024'))?.status).toBe(503);
  });

  it('mapeia P2034 (conflito de transação) para 409', () => {
    expect(mapPrismaClientError(knownError('P2034'))?.status).toBe(409);
  });

  it('mapeia código P1* (conexão) para 503', () => {
    expect(mapPrismaClientError(knownError('P1001'))?.status).toBe(503);
  });

  it('código known desconhecido cai em 500 genérico', () => {
    expect(mapPrismaClientError(knownError('P9999'))?.status).toBe(500);
  });

  it('devolve null para erro que não é do Prisma', () => {
    expect(mapPrismaClientError(new Error('erro qualquer'))).toBeNull();
  });

  it('mapeia PrismaClientValidationError para 400', () => {
    const err = new Prisma.PrismaClientValidationError('invalid', { clientVersion: '6.19.0' });
    expect(mapPrismaClientError(err)?.status).toBe(400);
  });

  it('mapeia PrismaClientInitializationError para 503', () => {
    const err = new Prisma.PrismaClientInitializationError('init failed', '6.19.0', 'P1001');
    expect(mapPrismaClientError(err)?.status).toBe(503);
  });

  it('mapeia PrismaClientRustPanicError para 503', () => {
    const err = new Prisma.PrismaClientRustPanicError('panic', '6.19.0');
    expect(mapPrismaClientError(err)?.status).toBe(503);
  });

  it('mapeia PrismaClientUnknownRequestError para 503', () => {
    const err = new Prisma.PrismaClientUnknownRequestError('unknown', { clientVersion: '6.19.0' });
    expect(mapPrismaClientError(err)?.status).toBe(503);
  });
});

describe('mapPrismaClientError em produção — esconde código técnico', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('P1* em produção usa code genérico DB_UNAVAILABLE', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { Prisma } = await import('@prisma/client');
    const { mapPrismaClientError } = await import('../../../server/shared/errors/prisma-errors.js');
    const err = new Prisma.PrismaClientKnownRequestError('conn', { code: 'P1001', clientVersion: '6.19.0' });
    expect(mapPrismaClientError(err)?.body.code).toBe('DB_UNAVAILABLE');
  });

  it('PrismaClientInitializationError em produção usa code DB_INIT', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { Prisma } = await import('@prisma/client');
    const { mapPrismaClientError } = await import('../../../server/shared/errors/prisma-errors.js');
    const err = new Prisma.PrismaClientInitializationError('init', '6.19.0', 'P1001');
    expect(mapPrismaClientError(err)?.body.code).toBe('DB_INIT');
  });

  it('PrismaClientUnknownRequestError em produção usa code UNKNOWN_DB', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { Prisma } = await import('@prisma/client');
    const { mapPrismaClientError } = await import('../../../server/shared/errors/prisma-errors.js');
    const err = new Prisma.PrismaClientUnknownRequestError('unknown', { clientVersion: '6.19.0' });
    expect(mapPrismaClientError(err)?.body.code).toBe('UNKNOWN_DB');
  });
});

describe('sendIfPrismaHttpError', () => {
  it('envia resposta e devolve true quando é erro Prisma mapeável', () => {
    const res = fakeRes();
    const sent = sendIfPrismaHttpError(res as any, knownError('P2002'), 'test-tag');
    expect(sent).toBe(true);
    expect(res.statusCode).toBe(409);
  });

  it('devolve false sem mexer na resposta quando não é erro Prisma', () => {
    const res = fakeRes();
    const sent = sendIfPrismaHttpError(res as any, new Error('não é prisma'), 'test-tag');
    expect(sent).toBe(false);
    expect(res.statusCode).toBeUndefined();
  });

  it('devolve false se headers já foram enviados', () => {
    const res = fakeRes();
    res.headersSent = true;
    const sent = sendIfPrismaHttpError(res as any, knownError('P2002'), 'test-tag');
    expect(sent).toBe(false);
  });

  it('lida com erro Prisma lançado como valor não-Error (edge case)', () => {
    const res = fakeRes();
    // Prisma sempre lança instâncias de Error de verdade; este teste só garante que
    // `sendIfPrismaHttpError` não quebra se algo estranho passar por aqui.
    const sent = sendIfPrismaHttpError(res as any, 'string qualquer', 'test-tag');
    expect(sent).toBe(false);
  });
});
