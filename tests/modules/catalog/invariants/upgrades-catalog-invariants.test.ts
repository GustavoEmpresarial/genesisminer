/**
 * Invariantes do catálogo canónico `upgrades` (Tarefa 6).
 * Escaneia código de produção Node à procura de writes proibidos/não allowlisted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SERVER_ROOT = path.join(ROOT, 'server');

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name === 'dist') continue;
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walkTsFiles(full, out);
    else if (name.isFile() && name.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('invariantes catálogo upgrades (T6)', () => {
  it('1) nenhum writer de produção usa DELETE em upgrades', () => {
    const files = walkTsFiles(SERVER_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      if (/\bDELETE\s+FROM\s+upgrades\b/i.test(text)) {
        offenders.push(path.relative(ROOT, file));
      }
      if (/\bprisma\.upgrades\.delete(Many)?\s*\(/i.test(text)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('1b) writers SQL de mutação em upgrades estão allowlisted', () => {
    const files = walkTsFiles(SERVER_ROOT);
    const mutators: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      if (
        /\bINSERT\s+INTO\s+upgrades\b/i.test(text) ||
        /\bUPDATE\s+upgrades\s+SET\b/i.test(text) ||
        /\bprisma\.upgrades\.(create|createMany|update|updateMany|upsert)\s*\(/i.test(text)
      ) {
        mutators.push(path.relative(ROOT, file).replace(/\\/g, '/'));
      }
    }
    expect(mutators.sort()).toEqual(['server/modules/merge/services/merge.ts']);
  });
});
