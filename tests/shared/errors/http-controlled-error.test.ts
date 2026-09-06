import { describe, expect, it } from 'vitest';
import { HttpControlledError } from '../../../server/shared/errors/http-controlled-error.js';

describe('HttpControlledError', () => {
  it('usa jsonBody.error como message quando presente', () => {
    const e = new HttpControlledError(409, { error: 'Conflito.' });
    expect(e.message).toBe('Conflito.');
    expect(e.statusCode).toBe(409);
    expect(e.jsonBody).toEqual({ error: 'Conflito.' });
    expect(e.name).toBe('HttpControlledError');
  });

  it('usa jsonBody.message quando não há error', () => {
    const e = new HttpControlledError(400, { message: 'Invalid data.' });
    expect(e.message).toBe('Invalid data.');
  });

  it('cai no fallback "Request failed" sem error/message', () => {
    const e = new HttpControlledError(500, { ok: false });
    expect(e.message).toBe('Request failed');
  });

  it('é instância de Error (compatível com try/catch e instanceof)', () => {
    const e = new HttpControlledError(403, { error: 'Proibido.' });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(HttpControlledError);
  });
});
