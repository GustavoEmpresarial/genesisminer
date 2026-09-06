import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMG_CANONICAL_SUBFOLDERS } from '../../../../server/modules/admin/image-asset/services/image-asset-model.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

describe('BACKUP_DIR runtime contract', () => {
  it('compose de teste define BACKUP_DIR=/app/storage/backups só no app (processo único)', () => {
    const yml = fs.readFileSync(path.join(repoRoot, 'deploy/docker-compose.yml'), 'utf8');
    const backupEnvHits = yml.match(/BACKUP_DIR:\s*\/app\/storage\/backups/g) ?? [];
    expect(backupEnvHits).toHaveLength(1);
    expect(yml).toMatch(/^\s+app:\s*$/m);
    expect(yml).not.toMatch(/^\s+app_scheduler:\s*$/m);
    const volumeHits = yml.match(/\.\.\/storage\/backups:\/app\/storage\/backups/g) ?? [];
    expect(volumeHits).toHaveLength(1);
    expect(yml).not.toMatch(/BACKUP_DIR:\s*\/backups\s*$/m);
  });

  it('healthcheck do compose aponta para readiness real (/health/ready), não /api/news', () => {
    const yml = fs.readFileSync(path.join(repoRoot, 'deploy/docker-compose.yml'), 'utf8');
    expect(yml).toMatch(/healthcheck:/);
    expect(yml).toMatch(/\/health\/ready/);
    expect(yml).not.toMatch(/\/api\/news['"]/);
    expect(yml).toMatch(/start_period:\s*90s/);
    expect(yml).toMatch(/interval:\s*10s/);
    expect(yml).toMatch(/timeout:\s*5s/);
    expect(yml).toMatch(/retries:\s*12/);
  });

  it('imagem Docker define ENV BACKUP_DIR=/app/storage/backups', () => {
    const docker = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
    expect(docker).toMatch(/^ENV BACKUP_DIR=\/app\/storage\/backups\s*$/m);
  });

  it('catálogo /img não inclui backups — static serving não expõe dumps', () => {
    expect(IMG_CANONICAL_SUBFOLDERS).not.toContain('backups');
    const staticSrc = fs.readFileSync(
      path.join(repoRoot, 'server/modules/admin/image-asset/services/static-serving.ts'),
      'utf8'
    );
    expect(staticSrc.toLowerCase()).not.toMatch('backup');
    expect(staticSrc).toMatch(/app\.use\('\/img', express\.static\(uploadsDir\)\)/);
    expect(staticSrc).toMatch(/app\.use\('\/img', express\.static\(imgDir\)\)/);
    expect(staticSrc).not.toMatch(/storage\/backups/);
  });
});
