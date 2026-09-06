import { describe, expect, it } from 'vitest';
import {
  SPA_BUILD_META_NAME,
  buildStampedSpaIndex,
  computeSpaBuildId,
  injectSpaBuildMeta
} from '../../server/bootstrap/spa-build-stamp.js';

const INDEX_HTML = [
  '<!DOCTYPE html>',
  '<html lang="en" class="dark">',
  '  <head>',
  '    <meta charset="UTF-8" />',
  '    <script type="module" src="/assets/index-AAAA1111.js"></script>',
  '  </head>',
  '  <body><div id="root"></div></body>',
  '</html>'
].join('\n');

describe('computeSpaBuildId', () => {
  it('é determinístico para o mesmo bundle (restart não invalida cache local)', () => {
    expect(computeSpaBuildId(INDEX_HTML)).toBe(computeSpaBuildId(INDEX_HTML));
  });

  it('muda quando o hash do asset muda', () => {
    const next = INDEX_HTML.replace('index-AAAA1111.js', 'index-BBBB2222.js');
    expect(computeSpaBuildId(next)).not.toBe(computeSpaBuildId(INDEX_HTML));
  });
});

describe('injectSpaBuildMeta', () => {
  it('insere a meta tag dentro do <head>', () => {
    const html = injectSpaBuildMeta(INDEX_HTML, 'abc123');
    expect(html).toContain(`<meta name="${SPA_BUILD_META_NAME}" content="abc123" />`);
    expect(html.indexOf(SPA_BUILD_META_NAME)).toBeLessThan(html.indexOf('</head>'));
  });

  it('substitui um selo anterior em vez de duplicar', () => {
    const once = injectSpaBuildMeta(INDEX_HTML, 'abc123');
    const twice = injectSpaBuildMeta(once, 'def456');
    expect(twice).toContain('content="def456"');
    expect(twice).not.toContain('content="abc123"');
    expect(twice.match(new RegExp(SPA_BUILD_META_NAME, 'g'))).toHaveLength(1);
  });

  it('sem <head> devolve o HTML intacto', () => {
    const raw = '<html><body>hi</body></html>';
    expect(injectSpaBuildMeta(raw, 'abc123')).toBe(raw);
  });

  it('preserva o resto do documento', () => {
    const html = injectSpaBuildMeta(INDEX_HTML, 'abc123');
    expect(html).toContain('/assets/index-AAAA1111.js');
    expect(html).toContain('<div id="root"></div>');
  });
});

describe('buildStampedSpaIndex', () => {
  it('devolve HTML selado com o id calculado do próprio HTML original', () => {
    const { html, buildId } = buildStampedSpaIndex(INDEX_HTML);
    expect(buildId).toBe(computeSpaBuildId(INDEX_HTML));
    expect(html).toContain(`content="${buildId}"`);
  });
});
