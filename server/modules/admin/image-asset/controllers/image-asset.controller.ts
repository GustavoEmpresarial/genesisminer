/**
 * Rotas de upload de imagem admin (`POST /api/admin/upload-image`,
 * `POST /api/admin/upload-ad`).
 *
 * Migrado de legacy/backend/controllers/imageAssetController.ts. As 2 rotas
 * admin (multipart via `multer`) e a conversão pra `.webp` (`sharp`) tinham
 * sido cortadas por essas duas libs não serem dependência de `current/server`
 * — porte confirmado explicitamente pelo dono do projeto; `multer`/`sharp`
 * adicionadas (`sharp` na versão `^0.35.3`, não a `^0.34.5` do legado — a
 * `0.34.x` tem uma CVE de libvips alta corrigida só na `0.35.3`, sem API
 * usada aqui que tenha mudado entre as duas).
 *
 * `POST /api/upload-image` (data URL) é Rust: genesis-api `admin_tabs.rs`
 * (gate `require_is_admin`) + mining-worker `/v1/uploads/admin-image-data-url`
 * (escrita em disco). Sem passo `.webp` lá — ver relatório do porte.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import {
  IMG_ADMIN_TARGET_SUBFOLDER_SET,
  buildStoredUploadFilename,
  sanitizeOriginalNameBase
} from '../services/image-asset-model.js';
import { isConvertibleRasterExt, publicPathToWebp } from '../services/webp-paths.js';
import { convertRasterFileToWebp } from '../services/webp-convert.js';
import { compressMediaFileInPlace } from '../services/compress-media.js';
import { assertImageFileMagicBytes } from '../services/magic-bytes.js';

export type ImageAssetModuleDeps = {
  isAdmin: RequestHandler;
  imgDir: string;
  uploadsDir: string;
};

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
/** Extensões + mimetypes aceites no upload admin (multipart, arte de itens). */
const ADMIN_UPLOAD_ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const ADMIN_UPLOAD_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
/** Limite generoso para arte de itens (multipart, sem inflar via base64). */
const ADMIN_UPLOAD_MAX_MB = 50;
const ADMIN_UPLOAD_MAX_BYTES = ADMIN_UPLOAD_MAX_MB * BYTES_PER_MB;
const ADMIN_UPLOAD_MAX_MB_LABEL = String(Math.round(ADMIN_UPLOAD_MAX_BYTES / BYTES_PER_MB));
const AD_UPLOAD_MAX_MB = 5;
const AD_UPLOAD_MAX_BYTES = AD_UPLOAD_MAX_MB * BYTES_PER_MB;
const AD_UPLOAD_MAX_FILES = 1;
const UNIQUE_SUFFIX_RANDOM_CEILING = 1e9;

const AD_UPLOAD_ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const AD_UPLOAD_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

/** Valida ext+mime do upload de anúncio contra as listas permitidas; normaliza `.jpeg` → `.jpg`. `null` se inválido. */
function normalizeAdUploadExt(originalName: string, mimetype: string): string | null {
  const ext = path.extname(originalName || '').toLowerCase();
  const mime = String(mimetype || '').toLowerCase();
  if (!AD_UPLOAD_ALLOWED_EXT.has(ext) || !AD_UPLOAD_ALLOWED_MIME.has(mime)) return null;
  if (ext === '.jpeg') return '.jpg';
  return ext;
}

/**
 * Multer para `/api/admin/upload-ad` — anúncios in-app, ficheiro único, grava em disco
 * como `ad-<timestamp>-<random>.<ext>`. Validação de magic bytes acontece depois, no
 * handler da rota (`assertImageFileMagicBytes`), não aqui — este multer só filtra por
 * extensão/mimetype declarados.
 */
function createAdminAdMulter(uploadsDir: string): ReturnType<typeof multer> {
  const adStorage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fs.mkdirSync(uploadsDir, { recursive: true });
      } catch {
        /* idempotente */
      }
      cb(null, uploadsDir);
    },
    filename: (_req, file, cb) => {
      const ext = normalizeAdUploadExt(file.originalname, file.mimetype);
      if (!ext) {
        cb(new Error('Formato de imagem inválido. Usa PNG, JPG ou GIF.'), '');
        return;
      }
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * UNIQUE_SUFFIX_RANDOM_CEILING)}`;
      cb(null, `ad-${uniqueSuffix}${ext}`);
    }
  });
  return multer({
    storage: adStorage,
    limits: { fileSize: AD_UPLOAD_MAX_BYTES, files: AD_UPLOAD_MAX_FILES },
    fileFilter: (_req, file, cb) => {
      if (normalizeAdUploadExt(file.originalname, file.mimetype)) cb(null, true);
      else cb(new Error('Formato de imagem inválido. Usa PNG, JPG ou GIF.'));
    }
  });
}

/**
 * Multer dedicado ao upload admin de imagens de itens. Recebe `multipart/form-data`
 * directamente em disco — sem passar por base64 / JSON — para escapar ao limite
 * global do body parser que derrubava uploads grandes.
 *
 * Aceita também o campo de texto `assetFolder` (subpasta canónica).
 */
function createAdminImageMulter(uploadsDir: string): ReturnType<typeof multer> {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fs.mkdirSync(uploadsDir, { recursive: true });
      } catch {
        /* idempotente */
      }
      cb(null, uploadsDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      const safeBase = sanitizeOriginalNameBase(file.originalname);
      cb(null, buildStoredUploadFilename(safeBase, ext));
    }
  });
  return multer({
    storage,
    limits: { fileSize: ADMIN_UPLOAD_MAX_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const mime = String(file.mimetype || '').toLowerCase();
      if (ADMIN_UPLOAD_ALLOWED_EXT.has(ext) && ADMIN_UPLOAD_ALLOWED_MIME.has(mime)) {
        cb(null, true);
      } else {
        cb(new Error('Formato de imagem inválido. Usa PNG, JPG, WEBP ou GIF.'));
      }
    }
  });
}

/**
 * Passo final comum aos 3 endpoints de upload: recomprime best-effort
 * (`compressMediaFileInPlace`, nunca lança — falha silenciosa mantém o
 * ficheiro original) e depois converte raster (png/jpg/gif) para `.webp`
 * (`convertRasterFileToWebp`, remove o original em sucesso). Se a conversão
 * falhar ou o ficheiro já não for raster convertível, devolve o
 * caminho/path público originais inalterados — nunca falha a resposta HTTP
 * por causa desta optimização.
 */
async function finalizeUploadAsWebp(absPath: string, publicPath: string): Promise<{ absPath: string; publicPath: string }> {
  try {
    await compressMediaFileInPlace(absPath);
  } catch {
    /* best-effort */
  }
  const ext = path.extname(absPath).toLowerCase();
  if (!isConvertibleRasterExt(ext)) return { absPath, publicPath };
  const conv = await convertRasterFileToWebp(absPath, { removeOriginal: true, quality: 85 });
  if (conv.ok && conv.converted) {
    return { absPath: conv.absPath, publicPath: publicPathToWebp(publicPath) };
  }
  return { absPath, publicPath };
}

/**
 * Regista as 2 rotas admin de upload de imagem.
 *
 * NOTA de consistência (não é bug de segurança, o outro endpoint já valida
 * extensão+mimetype declarados via `fileFilter` do multer): só
 * `/api/admin/upload-ad` valida magic bytes reais do ficheiro em disco
 * (`assertImageFileMagicBytes`) após gravar — `/api/admin/upload-image` confia
 * na extensão/mimetype declarados pelo cliente. Um ficheiro com conteúdo
 * diferente da extensão passaria nesse (ex. iria para
 * `sharp`/`convertRasterFileToWebp`, que tratam o erro de parsing e mantêm o
 * original — não crasha o servidor, mas não é validado como imagem real antes
 * de ficar servido publicamente em `/img/...`).
 */
export function registerImageAssetModuleRoutes(app: Express, deps: ImageAssetModuleDeps): void {
  const { isAdmin, imgDir, uploadsDir } = deps;
  const uploadAd = createAdminAdMulter(uploadsDir);
  const uploadAdminImage = createAdminImageMulter(uploadsDir);

  /**
   * Upload admin de imagens de itens / arte (Mercado de Hardware, Editor, etc.).
   *
   * Endpoint multipart (não JSON) para evitar o tecto do body parser e para
   * nunca usar 500 genérico em erros de validação.
   *
   *   Request:  multipart/form-data  field `image`  + opcional `assetFolder`
   *   Sucesso:  { ok: true, path: '/img/<sub>/<file>', url: same }
   *   Erros:    400 (mime/extensão inválida ou ficheiro em falta)
   *             401 (sem sessão), 403 (não-admin) — via `isAdmin`
   *             413 (ficheiro maior que ADMIN_UPLOAD_MAX_BYTES)
   *             500 (erro IO real ao gravar)
   */
  app.post('/api/admin/upload-image', isAdmin, (req: Request, res: Response) => {
    uploadAdminImage.single('image')(req, res, async (err: unknown) => {
      const uidLog = req.userId != null ? String(req.userId) : 'anon';
      if (err) {
        const e = err as { code?: string; message?: string };
        if (e?.code === 'LIMIT_FILE_SIZE') {
          console.warn('[AdminImageUpload] payload too large', { uid: uidLog });
          res.status(HTTP_PAYLOAD_TOO_LARGE).json({ ok: false, error: `Imagem muito grande (máx. ${ADMIN_UPLOAD_MAX_MB_LABEL} MB).` });
          return;
        }
        console.warn('[AdminImageUpload] multer error', { uid: uidLog, msg: e?.message });
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: e?.message || 'Formato de imagem inválido.' });
        return;
      }
      if (!req.file) {
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Nenhum ficheiro enviado.' });
        return;
      }
      const rawFolder = typeof req.body?.assetFolder === 'string' ? req.body.assetFolder : '';
      const targetSubfolder = rawFolder && IMG_ADMIN_TARGET_SUBFOLDER_SET.has(rawFolder) ? rawFolder : '';
      const tmpAbs = req.file.path;
      const filename = req.file.filename;
      let finalAbs = tmpAbs;
      let publicPath = `/img/${filename}`;
      if (targetSubfolder) {
        try {
          const destDir = path.join(imgDir, targetSubfolder);
          fs.mkdirSync(destDir, { recursive: true });
          const destAbs = path.join(destDir, filename);
          fs.renameSync(tmpAbs, destAbs);
          finalAbs = destAbs;
          publicPath = `/img/${targetSubfolder}/${filename}`;
        } catch (moveErr) {
          console.error('[AdminImageUpload] move to subfolder failed', {
            uid: uidLog,
            targetSubfolder,
            err: moveErr instanceof Error ? moveErr.message : String(moveErr)
          });
          /** Mantém em uploads/ — preferimos entregar a imagem do que falhar. */
        }
      }
      const finalized = await finalizeUploadAsWebp(finalAbs, publicPath);
      console.log('[AdminImageUpload] ok', { uid: uidLog, size: req.file.size, mime: req.file.mimetype, path: finalized.publicPath });
      res.json({ ok: true, path: finalized.publicPath, url: finalized.publicPath });
    });
  });

  app.post('/api/admin/upload-ad', isAdmin, (req: Request, res: Response) => {
    uploadAd.single('image')(req, res, async (err: unknown) => {
      if (err) {
        const msg = err instanceof Error ? err.message : 'Erro no upload';
        console.error('[Upload] Multer Error:', err);
        res.status(HTTP_BAD_REQUEST).json({ error: 'Erro no upload: ' + msg });
        return;
      }
      if (!req.file) {
        res.status(HTTP_BAD_REQUEST).json({ error: 'Nenhum arquivo enviado' });
        return;
      }
      const ext = path.extname(req.file.filename).toLowerCase();
      const absAd = path.join(uploadsDir, req.file.filename);
      if (!assertImageFileMagicBytes(absAd, ext)) {
        try {
          fs.unlinkSync(absAd);
        } catch {
          /* ignore */
        }
        res.status(HTTP_BAD_REQUEST).json({ error: 'Ficheiro não é uma imagem válida (PNG, JPG ou GIF).' });
        return;
      }
      const imageUrl = `/img/uploads/${req.file.filename}`;
      const finalized = await finalizeUploadAsWebp(absAd, imageUrl);
      res.json({ ok: true, imageUrl: finalized.publicPath });
    });
  });
}
