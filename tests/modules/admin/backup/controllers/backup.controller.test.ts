import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const routes: Record<string, (req: any, res: any) => Promise<void> | void> = {};
  return {
    get: (routePath: string, ...fns: any[]) => {
      routes[`GET ${routePath}`] = fns[fns.length - 1];
    },
    post: (routePath: string, ...fns: any[]) => {
      routes[`POST ${routePath}`] = fns[fns.length - 1];
    },
    delete: (routePath: string, ...fns: any[]) => {
      routes[`DELETE ${routePath}`] = fns[fns.length - 1];
    },
    routes
  };
}

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headers: {} as Record<string, string>,
    downloaded: undefined as { path: string; name: string } | undefined,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
    download(p: string, name: string) {
      res.downloaded = { path: p, name };
    }
  };
  return res;
}

const isAdmin = (_req: any, _res: any, next: any) => next();

describe('registerAdminBackupModuleRoutes', () => {
  let filesMock: Record<string, any>;
  let root: string;

  beforeEach(() => {
    vi.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-controller-test-'));
    filesMock = {
      getBackupDir: vi.fn().mockReturnValue(root),
      resolveSafeBackupPath: vi.fn((fn: string) => path.join(root, path.basename(String(fn)))),
      runPgDumpToFile: vi.fn().mockResolvedValue(undefined)
    };
    vi.doMock('../../../../../server/modules/admin/backup/services/backup-files.js', () => filesMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/modules/admin/backup/services/backup-files.js');
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function loadApp() {
    const { registerAdminBackupModuleRoutes } = await import('../../../../../server/modules/admin/backup/controllers/backup.controller.js');
    const app = fakeApp();
    registerAdminBackupModuleRoutes(app as any, { isAdmin });
    return app;
  }

  describe('GET /api/admin/backups', () => {
    it('lista só ficheiros com extensão de backup, mais recentes primeiro', async () => {
      fs.writeFileSync(path.join(root, 'a.sql'), 'x');
      await new Promise((r) => setTimeout(r, 5));
      fs.writeFileSync(path.join(root, 'b.sql'), 'x');
      fs.writeFileSync(path.join(root, 'ignore.txt'), 'x');
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin/backups']({ headers: {} }, res);
      expect(filesMock.getBackupDir).toHaveBeenCalled();
      expect(res.body.map((f: any) => f.filename)).toEqual(['b.sql', 'a.sql']);
    });
  });

  describe('POST /api/admin/backup', () => {
    it('nome inválido (resolveSafeBackupPath null): 400', async () => {
      filesMock.resolveSafeBackupPath.mockReturnValue(null);
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/backup']({ headers: {}, body: {} }, res);
      expect(res.statusCode).toBe(400);
    });

    it('caminho feliz: chama pg_dump e devolve bytes/filename', async () => {
      filesMock.runPgDumpToFile.mockImplementation(async (dest: string) => {
        fs.writeFileSync(dest, 'sql-content');
      });
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/backup']({ headers: {}, body: { name: 'meu backup!!' } }, res);
      expect(res.body.ok).toBe(true);
      expect(res.body.filename).toMatch(/^meu_backup___\d/);
      expect(res.body.bytes).toBe(11);
      expect(filesMock.resolveSafeBackupPath).toHaveBeenCalled();
      expect(filesMock.runPgDumpToFile).toHaveBeenCalledWith(expect.stringMatching(/[/\\]meu_backup__/));
    });

    it('pg_dump falha: 500, remove ficheiro parcial se existir', async () => {
      filesMock.runPgDumpToFile.mockImplementation(async (dest: string) => {
        fs.writeFileSync(dest, 'partial');
        throw new Error('pg_dump: ENOENT');
      });
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/backup']({ headers: {}, body: {} }, res);
      expect(res.statusCode).toBe(500);
      expect(res.body.error).toContain('Docker');
    });
  });

  describe('DELETE /api/admin/backups/:filename', () => {
    it('nome inválido: 400', async () => {
      filesMock.resolveSafeBackupPath.mockReturnValue(null);
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['DELETE /api/admin/backups/:filename']({ headers: {}, params: { filename: 'x' } }, res);
      expect(res.statusCode).toBe(400);
    });

    it('ficheiro inexistente: 404', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['DELETE /api/admin/backups/:filename']({ headers: {}, params: { filename: 'nao-existe.sql' } }, res);
      expect(res.statusCode).toBe(404);
    });

    it('caminho feliz: apaga e devolve ok', async () => {
      fs.writeFileSync(path.join(root, 'del.sql'), 'x');
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['DELETE /api/admin/backups/:filename']({ headers: {}, params: { filename: 'del.sql' } }, res);
      expect(res.body).toEqual({ ok: true });
      expect(fs.existsSync(path.join(root, 'del.sql'))).toBe(false);
      expect(filesMock.resolveSafeBackupPath).toHaveBeenCalledWith('del.sql');
    });
  });

  describe('GET /api/admin/backups/download/:filename', () => {
    it('nome inválido: 400', async () => {
      filesMock.resolveSafeBackupPath.mockReturnValue(null);
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin/backups/download/:filename']({ headers: {}, params: { filename: 'x' } }, res);
      expect(res.statusCode).toBe(400);
    });

    it('ficheiro inexistente: 404', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin/backups/download/:filename']({ headers: {}, params: { filename: 'nope.sql' } }, res);
      expect(res.statusCode).toBe(404);
    });

    it('caminho feliz (.sql): seta Content-Type texto e chama download', async () => {
      fs.writeFileSync(path.join(root, 'ok.sql'), 'x');
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin/backups/download/:filename']({ headers: {}, params: { filename: 'ok.sql' } }, res);
      expect(res.headers['Content-Type']).toContain('text/plain');
      expect(res.downloaded).toEqual({ path: path.join(root, 'ok.sql'), name: 'ok.sql' });
      expect(filesMock.resolveSafeBackupPath).toHaveBeenCalledWith('ok.sql');
    });
  });
});
