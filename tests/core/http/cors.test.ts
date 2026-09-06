import { describe, expect, it } from 'vitest';
import { buildCorsMiddleware, buildCorsOriginSet, isOriginAllowed } from '../../../server/core/http/cors.js';

describe('buildCorsOriginSet', () => {
  it('inclui FRONTEND_URL normalizada (sem barra final)', () => {
    const set = buildCorsOriginSet({ FRONTEND_URL: 'https://app.example.com/' } as NodeJS.ProcessEnv);
    expect(set.has('https://app.example.com')).toBe(true);
  });

  it('usa PUBLIC_URL/SITE_URL/VITE_APP_URL como aliases quando FRONTEND_URL ausente', () => {
    const set = buildCorsOriginSet({ SITE_URL: 'https://site.example.com' } as NodeJS.ProcessEnv);
    expect(set.has('https://site.example.com')).toBe(true);
  });

  it('adiciona CORS_ALLOWED_ORIGINS e CORS_EXTRA_ORIGINS (separados por vírgula)', () => {
    const set = buildCorsOriginSet({
      CORS_ALLOWED_ORIGINS: 'https://a.com, https://b.com',
      CORS_EXTRA_ORIGINS: 'https://c.com'
    } as NodeJS.ProcessEnv);
    expect(set.has('https://a.com')).toBe(true);
    expect(set.has('https://b.com')).toBe(true);
    expect(set.has('https://c.com')).toBe(true);
  });

  it('não inclui domínio nenhum hardcoded quando o env está vazio', () => {
    const set = buildCorsOriginSet({} as NodeJS.ProcessEnv);
    expect(set.size).toBe(0);
  });

  it('ignora entradas vazias/whitespace na lista', () => {
    const set = buildCorsOriginSet({ CORS_ALLOWED_ORIGINS: 'https://a.com, ,  ' } as NodeJS.ProcessEnv);
    expect(set.size).toBe(1);
    expect(set.has('https://a.com')).toBe(true);
  });
});

describe('isOriginAllowed', () => {
  const allowed = new Set(['https://app.example.com']);

  it('aceita localhost em qualquer porta (dev)', () => {
    expect(isOriginAllowed('http://localhost:5173', allowed)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3000', allowed)).toBe(true);
  });

  it('aceita origem na allowlist', () => {
    expect(isOriginAllowed('https://app.example.com', allowed)).toBe(true);
  });

  it('rejeita origem fora da allowlist', () => {
    expect(isOriginAllowed('https://evil.example.com', allowed)).toBe(false);
  });

  it('não confunde subdomínio de localhost com localhost real', () => {
    expect(isOriginAllowed('http://evil-localhost.com', allowed)).toBe(false);
  });
});

describe('buildCorsMiddleware', () => {
  it('devolve um middleware Express (a lógica de decisão é testada via isOriginAllowed acima)', () => {
    const mw = buildCorsMiddleware({ FRONTEND_URL: 'https://app.example.com' } as NodeJS.ProcessEnv);
    expect(typeof mw).toBe('function');
  });
});
