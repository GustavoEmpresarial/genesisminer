import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TOPIDLE_VERIFICATION_META_NAME,
  TOPIDLE_VERIFICATION_TOKEN
} from '../../../../client/src/shared/seo/topidleVerification.js';

const INDEX_HTML = readFileSync(join(process.cwd(), 'client/index.html'), 'utf8');

describe('TopIdle verification claim', () => {
  it('token e nome da meta são os do painel TopIdle', () => {
    expect(TOPIDLE_VERIFICATION_META_NAME).toBe('topidle-verification');
    expect(TOPIDLE_VERIFICATION_TOKEN).toBe('topidle-P88B3j9aCymWcLRxfUkTFY8H');
  });

  it('index.html tem a meta no head (crawler SPA não corre JS)', () => {
    const head = INDEX_HTML.slice(0, INDEX_HTML.indexOf('</head>'));
    expect(head).toContain(
      `<meta name="${TOPIDLE_VERIFICATION_META_NAME}" content="${TOPIDLE_VERIFICATION_TOKEN}"`
    );
  });

  it('index.html tem o token no body (fora do #root)', () => {
    const body = INDEX_HTML.slice(INDEX_HTML.indexOf('<body'));
    const rootAt = body.indexOf('id="root"');
    expect(rootAt).toBeGreaterThan(0);
    expect(body.slice(0, rootAt)).toContain(TOPIDLE_VERIFICATION_TOKEN);
  });
});
