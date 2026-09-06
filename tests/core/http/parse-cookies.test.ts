import { describe, expect, it } from 'vitest';
import { parseCookies } from '../../../server/core/http/parse-cookies.js';

function fakeReq(cookieHeader?: string): any {
  return { headers: { cookie: cookieHeader } };
}

describe('parseCookies', () => {
  it('devolve objeto vazio sem header cookie', () => {
    expect(parseCookies(fakeReq())).toEqual({});
  });

  it('faz parse de um cookie único', () => {
    expect(parseCookies(fakeReq('sid=abc123'))).toEqual({ sid: 'abc123' });
  });

  it('faz parse de múltiplos cookies separados por ;', () => {
    expect(parseCookies(fakeReq('sid=abc123; gm_access=tok1; gm_refresh=tok2'))).toEqual({
      sid: 'abc123',
      gm_access: 'tok1',
      gm_refresh: 'tok2'
    });
  });

  it('ignora entradas malformadas (sem "=")', () => {
    expect(parseCookies(fakeReq('sid=abc; malformado; gm_access=tok'))).toEqual({
      sid: 'abc',
      gm_access: 'tok'
    });
  });

  it('valor pode conter "=" (ex.: base64 com padding)', () => {
    expect(parseCookies(fakeReq('gm_access=abc==def'))).toEqual({ gm_access: 'abc==def' });
  });
});
