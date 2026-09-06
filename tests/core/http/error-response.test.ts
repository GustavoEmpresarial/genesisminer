import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeRes() {
  const res: any = {
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

// `IS_PROD` em error-response.ts é lido de `process.env.NODE_ENV` uma vez, no import do
// módulo (mesmo padrão do legado) — em produção de verdade isso nunca muda em runtime,
// mas pra testar os dois ramos aqui precisamos resetar o módulo e reimportar depois de
// mudar o env (mesmo padrão usado em ../security/mailer.test.ts).
describe('sendInternalError', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('em produção esconde a mensagem técnica', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { sendInternalError, INTERNAL_ERROR_PUBLIC } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    sendInternalError(res, 'tag', new Error('detalhe sensível'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: INTERNAL_ERROR_PUBLIC });
  });

  it('em dev devolve err.message', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { sendInternalError } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    sendInternalError(res, 'tag', new Error('detalhe técnico'));
    expect(res.body).toEqual({ error: 'detalhe técnico' });
  });

  it('erro que não é instância de Error usa String(err) como mensagem', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { sendInternalError } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    sendInternalError(res, 'tag', 'string qualquer');
    expect(res.body).toEqual({ error: 'string qualquer' });
  });

  it('não faz nada se headers já enviados', async () => {
    const { sendInternalError } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    res.headersSent = true;
    sendInternalError(res, 'tag', new Error('x'));
    expect(res.statusCode).toBeUndefined();
  });
});

describe('sendInternalErrorSafeMessage', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('em produção usa a publicMessage fornecida pela rota', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { sendInternalErrorSafeMessage } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    sendInternalErrorSafeMessage(res, 'tag', new Error('interno'), 'mensagem segura');
    expect(res.body).toEqual({ error: 'mensagem segura' });
  });

  it('em dev prefere a mensagem técnica quando existir', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { sendInternalErrorSafeMessage } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    sendInternalErrorSafeMessage(res, 'tag', new Error('detalhe técnico'), 'mensagem segura');
    expect(res.body).toEqual({ error: 'detalhe técnico' });
  });
});

describe('respondIfHttpControlledError', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('envia status/corpo do HttpControlledError e devolve true', async () => {
    // HttpControlledError e respondIfHttpControlledError vêm do mesmo import dinâmico —
    // misturar com um import estático daria classes de módulos diferentes (instanceof falso).
    const { respondIfHttpControlledError, HttpControlledError } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    const handled = respondIfHttpControlledError(res, new HttpControlledError(422, { error: 'inválido' }));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ error: 'inválido' });
  });

  it('devolve false para erro comum, sem mexer na resposta', async () => {
    const { respondIfHttpControlledError } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    const handled = respondIfHttpControlledError(res, new Error('normal'));
    expect(handled).toBe(false);
    expect(res.statusCode).toBeUndefined();
  });
});

describe('variantes *OrPrisma — tratam erro Prisma antes do 500 genérico', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('sendInternalErrorOrPrisma usa o mapeamento Prisma quando aplicável', async () => {
    const { Prisma } = await import('@prisma/client');
    const { sendInternalErrorOrPrisma } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    const err = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '6.19.0' });
    sendInternalErrorOrPrisma(res, 'tag', err);
    expect(res.statusCode).toBe(409);
  });

  it('sendInternalErrorOrPrisma cai no 500 genérico pra erro não-Prisma', async () => {
    const { sendInternalErrorOrPrisma } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    sendInternalErrorOrPrisma(res, 'tag', new Error('normal'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it('sendInternalErrorSafeMessageOrPrisma usa Prisma quando aplicável', async () => {
    const { Prisma } = await import('@prisma/client');
    const { sendInternalErrorSafeMessageOrPrisma } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    const err = new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: '6.19.0' });
    sendInternalErrorSafeMessageOrPrisma(res, 'tag', err, 'fallback seguro');
    expect(res.statusCode).toBe(404);
  });

  it('sendInternalErrorShapeOrPrisma usa Prisma quando aplicável', async () => {
    const { Prisma } = await import('@prisma/client');
    const { sendInternalErrorShapeOrPrisma } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    const err = new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: '6.19.0' });
    sendInternalErrorShapeOrPrisma(res, 'tag', err, { ok: false });
    expect(res.statusCode).toBe(400);
  });

  it('sendInternalErrorSafeMessageOrPrisma cai no fallback pra erro não-Prisma', async () => {
    const { sendInternalErrorSafeMessageOrPrisma } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    sendInternalErrorSafeMessageOrPrisma(res, 'tag', new Error('normal'), 'mensagem segura');
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it('sendInternalErrorShapeOrPrisma cai no fallback pra erro não-Prisma', async () => {
    const { sendInternalErrorShapeOrPrisma } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    sendInternalErrorShapeOrPrisma(res, 'tag', new Error('normal'), { ok: false });
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ ok: false });
  });
});

describe('sendInternalErrorShape', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('mantém campos extra no corpo em produção', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { sendInternalErrorShape, INTERNAL_ERROR_PUBLIC } = await import('../../../server/core/http/error-response.js');
    const res = fakeRes();
    sendInternalErrorShape(res, 'tag', new Error('x'), { ok: false, report: [] });
    expect(res.body).toEqual({ ok: false, report: [], error: INTERNAL_ERROR_PUBLIC });
  });
});
