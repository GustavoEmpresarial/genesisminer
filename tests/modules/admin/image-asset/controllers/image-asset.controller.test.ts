import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const routes: Record<string, (req: any, res: any) => Promise<void> | void> = {};
  return {
    post: (routePath: string, ...fns: any[]) => {
      routes[`POST ${routePath}`] = fns[fns.length - 1];
    },
    routes
  };
}

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    }
  };
  return res;
}

/**
 * Substitui `multer` por um stub controlável por teste — evita ter de simular
 * parsing multipart real (é uma lib de terceiros já testada; o que queremos
 * verificar aqui é só a lógica da nossa rota em torno do resultado do multer:
 * erro/sem-ficheiro/ficheiro válido, mover pra subpasta, magic bytes, resposta).
 */
function multerStub() {
  let nextErr: unknown = null;
  let nextFile: Record<string, unknown> | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  const single = (_field: string) => (req: any, _res: any, cb: (err: unknown) => unknown) => {
    if (nextFile) req.file = nextFile;
    pending = Promise.resolve(cb(nextErr));
  };
  const diskStorage = (_opts: unknown) => ({});
  const factory: any = (_opts: unknown) => ({ single });
  factory.diskStorage = diskStorage;
  return {
    factory,
    setNextError: (e: unknown) => {
      nextErr = e;
    },
    setNextFile: (f: Record<string, unknown> | null) => {
      nextFile = f;
    },
    /** A rota não faz `await` no `.single()(...)` (é fire-and-forget, igual ao multer real) — o teste espera aqui. */
    flush: () => pending
  };
}

describe('registerImageAssetModuleRoutes', () => {
  let root: string;
  let uploadsDir: string;
  let imgDir: string;
  let multerCtl: ReturnType<typeof multerStub>;

  beforeEach(() => {
    vi.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'img-upload-test-'));
    uploadsDir = path.join(root, 'uploads');
    imgDir = root;
    fs.mkdirSync(uploadsDir, { recursive: true });
    multerCtl = multerStub();
    vi.doMock('multer', () => ({ default: multerCtl.factory }));
  });

  afterEach(() => {
    vi.doUnmock('multer');
    fs.rmSync(root, { recursive: true, force: true });
  });

  const isAdmin = (_req: any, _res: any, next: any) => next();

  async function loadApp() {
    const { registerImageAssetModuleRoutes } = await import('../../../../../server/modules/admin/image-asset/controllers/image-asset.controller.js');
    const app = fakeApp();
    registerImageAssetModuleRoutes(app as any, { isAdmin, imgDir, uploadsDir });
    return app;
  }

  it('não registra `POST /api/upload-image` (data URL é Rust: admin_tabs + worker)', async () => {
    const app = await loadApp();
    expect(app.routes['POST /api/upload-image']).toBeUndefined();
    expect(Object.keys(app.routes).sort()).toEqual([
      'POST /api/admin/upload-ad',
      'POST /api/admin/upload-image'
    ]);
  });

  describe('POST /api/admin/upload-image', () => {
    it('erro LIMIT_FILE_SIZE do multer: 413', async () => {
      multerCtl.setNextError({ code: 'LIMIT_FILE_SIZE', message: 'too big' });
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/upload-image']({ headers: {}, userId: 7, body: {} }, res);
      await multerCtl.flush();
      expect(res.statusCode).toBe(413);
    });

    it('outro erro do multer (mime inválido): 400', async () => {
      multerCtl.setNextError(new Error('Formato de imagem inválido. Usa PNG, JPG, WEBP ou GIF.'));
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/upload-image']({ headers: {}, userId: 7, body: {} }, res);
      await multerCtl.flush();
      expect(res.statusCode).toBe(400);
    });

    it('sem ficheiro: 400', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/upload-image']({ headers: {}, userId: 7, body: {} }, res);
      await multerCtl.flush();
      expect(res.statusCode).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('caminho feliz sem assetFolder: devolve path/url em uploads/', async () => {
      const filename = 'stored-image.png';
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, 'not-a-real-png');
      multerCtl.setNextFile({ path: filePath, filename, size: 14, mimetype: 'image/png' });
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/upload-image']({ headers: {}, userId: 7, body: {} }, res);
      await multerCtl.flush();
      expect(res.body).toMatchObject({ ok: true, path: `/img/${filename}`, url: `/img/${filename}` });
    });

    it('com assetFolder válido: move o ficheiro pra subpasta e o path público reflete isso', async () => {
      const filename = 'stored-image.png';
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, 'not-a-real-png');
      multerCtl.setNextFile({ path: filePath, filename, size: 14, mimetype: 'image/png' });
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/upload-image']({ headers: {}, userId: 7, body: { assetFolder: 'miner' } }, res);
      await multerCtl.flush();
      expect(res.body).toMatchObject({ ok: true, path: `/img/miner/${filename}` });
      expect(fs.existsSync(path.join(imgDir, 'miner', filename))).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('assetFolder fora do allowlist: ignora e mantém em uploads/', async () => {
      const filename = 'stored-image.png';
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, 'not-a-real-png');
      multerCtl.setNextFile({ path: filePath, filename, size: 14, mimetype: 'image/png' });
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/upload-image']({ headers: {}, userId: 7, body: { assetFolder: 'nao-permitida' } }, res);
      await multerCtl.flush();
      expect(res.body.path).toBe(`/img/${filename}`);
    });
  });

  describe('POST /api/admin/upload-ad', () => {
    it('erro do multer: 400', async () => {
      multerCtl.setNextError(new Error('Formato de imagem inválido. Usa PNG, JPG ou GIF.'));
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/upload-ad']({ headers: {}, body: {} }, res);
      await multerCtl.flush();
      expect(res.statusCode).toBe(400);
    });

    it('sem ficheiro: 400', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/upload-ad']({ headers: {}, body: {} }, res);
      await multerCtl.flush();
      expect(res.statusCode).toBe(400);
    });

    it('magic bytes não batem com a extensão declarada: 400 e apaga o ficheiro', async () => {
      const filename = 'ad-1-1.png';
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, 'definitely-not-a-png');
      multerCtl.setNextFile({ filename });
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/upload-ad']({ headers: {}, body: {} }, res);
      await multerCtl.flush();
      expect(res.statusCode).toBe(400);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('caminho feliz: PNG com magic bytes válidos devolve imageUrl', async () => {
      const filename = 'ad-1-2.png';
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      multerCtl.setNextFile({ filename });
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/upload-ad']({ headers: {}, body: {} }, res);
      await multerCtl.flush();
      expect(res.body).toMatchObject({ ok: true, imageUrl: `/img/uploads/${filename}` });
    });
  });
});
