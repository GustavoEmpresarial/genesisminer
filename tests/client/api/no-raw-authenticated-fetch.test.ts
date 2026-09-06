/**
 * Guard: authenticated client requests must not use raw `fetch(` (bypass session-expired).
 * Allowlist: apiFetch implementation + public turnstile config.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = path.resolve(HERE, '../../../client/src');

const ALLOW_RAW_FETCH = new Set([
  path.join(CLIENT_SRC, 'shared/api/http.ts'),
  path.join(CLIENT_SRC, 'shared/auth/turnstile.ts')
]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTsFiles(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

const FETCH_RE = /(?<![\w.])fetch\s*\(/g;

describe('client HTTP — no authenticated raw fetch', () => {
  it('only http.ts and turnstile.ts may call fetch( directly', () => {
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of walkTsFiles(CLIENT_SRC)) {
      if (ALLOW_RAW_FETCH.has(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((text, i) => {
        if (FETCH_RE.test(text)) {
          offenders.push({ file: path.relative(CLIENT_SRC, file), line: i + 1, text: text.trim() });
        }
        FETCH_RE.lastIndex = 0;
      });
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it('AdminBackup uses apiFetch (formerly raw) for authenticated list', () => {
    const src = fs.readFileSync(path.join(CLIENT_SRC, 'features/admin/ui/AdminBackup.tsx'), 'utf8');
    expect(src).toMatch(/apiFetch\(['"]\/api\/admin\/backups['"]\)/);
    expect(src).not.toMatch(/(?<![\w.])fetch\s*\(/);
  });
});
