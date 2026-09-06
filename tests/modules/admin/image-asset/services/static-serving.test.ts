import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const uses: Array<{ mountPath: string; handler: (req: any, res: any, next: any) => void }> = [];
  return {
    use: (mountPath: string, handler: any) => {
      uses.push({ mountPath, handler });
    },
    uses
  };
}

function fakeRes() {
  const res: any = {
    sentFile: undefined as string | undefined,
    typeSet: undefined as string | undefined,
    type(t: string) {
      res.typeSet = t;
      return res;
    },
    sendFile(p: string, cb: (err?: Error) => void) {
      res.sentFile = p;
      cb();
    }
  };
  return res;
}

describe('admin/image-asset services/static-serving', () => {
  let root: string;
  let uploadsDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'img-static-test-'));
    uploadsDir = path.join(root, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('mountImageStaticMiddleware', () => {
    it('regista 5 middlewares em /img (flat, relocate, webp, 2x express.static)', async () => {
      const { mountImageStaticMiddleware } = await import('../../../../../server/modules/admin/image-asset/services/static-serving.js');
      const app = fakeApp();
      mountImageStaticMiddleware(app as any, uploadsDir, root);
      expect(app.uses).toHaveLength(5);
      expect(app.uses.every((u) => u.mountPath === '/img')).toBe(true);
    });

    it('middleware "flat legacy": resolve /img/foo.png em uploads/ e chama sendFile', async () => {
      fs.writeFileSync(path.join(uploadsDir, 'foo.png'), 'x');
      const { mountImageStaticMiddleware } = await import('../../../../../server/modules/admin/image-asset/services/static-serving.js');
      const app = fakeApp();
      mountImageStaticMiddleware(app as any, uploadsDir, root);
      const flatMw = app.uses[0].handler;
      const res = fakeRes();
      const next = vi.fn();
      flatMw({ method: 'GET', originalUrl: '/img/foo.png' }, res, next);
      expect(res.sentFile).toBe(path.resolve(uploadsDir, 'foo.png'));
      expect(next).not.toHaveBeenCalled();
    });

    it('middleware "flat legacy": método POST passa direto (next)', async () => {
      const { mountImageStaticMiddleware } = await import('../../../../../server/modules/admin/image-asset/services/static-serving.js');
      const app = fakeApp();
      mountImageStaticMiddleware(app as any, uploadsDir, root);
      const flatMw = app.uses[0].handler;
      const next = vi.fn();
      flatMw({ method: 'POST', originalUrl: '/img/foo.png' }, fakeRes(), next);
      expect(next).toHaveBeenCalled();
    });

    it('middleware "webp fallback": serve .webp quando .png só existe convertido', async () => {
      fs.writeFileSync(path.join(uploadsDir, 'bar.webp'), 'x');
      const { mountImageStaticMiddleware } = await import('../../../../../server/modules/admin/image-asset/services/static-serving.js');
      const app = fakeApp();
      mountImageStaticMiddleware(app as any, uploadsDir, root);
      const webpMw = app.uses[2].handler;
      const res = fakeRes();
      const next = vi.fn();
      webpMw({ method: 'GET', originalUrl: '/img/bar.png' }, res, next);
      expect(res.sentFile).toBe(path.join(uploadsDir, 'bar.webp'));
      expect(res.typeSet).toBe('image/webp');
    });

    it('middleware "webp fallback": ficheiro original existe → passa direto (next), não força webp', async () => {
      fs.writeFileSync(path.join(uploadsDir, 'baz.png'), 'x');
      const { mountImageStaticMiddleware } = await import('../../../../../server/modules/admin/image-asset/services/static-serving.js');
      const app = fakeApp();
      mountImageStaticMiddleware(app as any, uploadsDir, root);
      const webpMw = app.uses[2].handler;
      const next = vi.fn();
      webpMw({ method: 'GET', originalUrl: '/img/baz.png' }, fakeRes(), next);
      expect(next).toHaveBeenCalled();
    });

    it('middleware "webp fallback": path traversal ou extensão não conversível passa direto', async () => {
      const { mountImageStaticMiddleware } = await import('../../../../../server/modules/admin/image-asset/services/static-serving.js');
      const app = fakeApp();
      mountImageStaticMiddleware(app as any, uploadsDir, root);
      const webpMw = app.uses[2].handler;
      const next1 = vi.fn();
      webpMw({ method: 'GET', originalUrl: '/img/../../etc/passwd.png' }, fakeRes(), next1);
      expect(next1).toHaveBeenCalled();
      const next2 = vi.fn();
      webpMw({ method: 'GET', originalUrl: '/img/foo.svg' }, fakeRes(), next2);
      expect(next2).toHaveBeenCalled();
    });

    it('middleware "relocate": /img/miner/X encontra ficheiro já em rack/', async () => {
      const rackDir = path.join(root, 'rack');
      fs.mkdirSync(rackDir, { recursive: true });
      fs.writeFileSync(path.join(rackDir, 'moved.webp'), 'x');
      const { mountImageStaticMiddleware } = await import('../../../../../server/modules/admin/image-asset/services/static-serving.js');
      const app = fakeApp();
      mountImageStaticMiddleware(app as any, uploadsDir, root);
      const relocateMw = app.uses[1].handler;
      const res = fakeRes();
      const next = vi.fn();
      relocateMw({ method: 'GET', originalUrl: '/img/miner/moved.webp' }, res, next);
      expect(res.sentFile).toBe(path.resolve(rackDir, 'moved.webp'));
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('runImageRootStartupOrganizeIfEnabled', () => {
    it('SKIP_IMG_AUTO_ORGANIZE=1: não organiza', async () => {
      vi.stubEnv('SKIP_IMG_AUTO_ORGANIZE', '1');
      fs.writeFileSync(path.join(root, 'carregador_x.png'), 'x');
      const { runImageRootStartupOrganizeIfEnabled } = await import('../../../../../server/modules/admin/image-asset/services/static-serving.js');
      runImageRootStartupOrganizeIfEnabled(root);
      expect(fs.existsSync(path.join(root, 'carregador_x.png'))).toBe(true);
      vi.unstubAllEnvs();
    });

    it('processo único (sem cluster): organiza a raiz', async () => {
      fs.writeFileSync(path.join(root, 'carregador_x.png'), 'x');
      const { runImageRootStartupOrganizeIfEnabled } = await import('../../../../../server/modules/admin/image-asset/services/static-serving.js');
      runImageRootStartupOrganizeIfEnabled(root);
      expect(fs.existsSync(path.join(root, 'charger', 'carregador_x.png'))).toBe(true);
    });

    it('erro ao organizar não propaga (best-effort)', async () => {
      const { runImageRootStartupOrganizeIfEnabled } = await import('../../../../../server/modules/admin/image-asset/services/static-serving.js');
      expect(() => runImageRootStartupOrganizeIfEnabled(path.join(root, 'nao-existe-nunca'))).not.toThrow();
    });
  });
});
