/**
 * Middleware de estáticos de `/img` — resolve URLs antigas sem subpasta e faz
 * fallback pra `.webp` quando o ficheiro só existe convertido.
 *
 * Migrado de legacy/backend/controllers/imageAssetController.ts (parte de
 * middleware/organização — a parte de upload fica em `../controllers/`).
 */
import fs from 'node:fs';
import path from 'node:path';
import cluster from 'node:cluster';
import type { Express, RequestHandler } from 'express';
import express from 'express';
import {
  IMG_CANONICAL_SUBFOLDERS,
  IMG_LEGACY_FOLDER_ALIASES,
  organizeLooseFilesInImgRoot,
  resolveLegacyFlatImgFilePath
} from './image-asset-model.js';
import { isConvertibleRasterExt, webpSiblingPath } from './webp-paths.js';

const CATALOG_SUB_SET = new Set<string>([
  ...IMG_CANONICAL_SUBFOLDERS,
  ...Object.keys(IMG_LEGACY_FOLDER_ALIASES)
]);

/** GET/HEAD `/img/ficheiro.ext` sem subpasta: procura em uploads e subpastas (URLs antigas na BD). */
function createLegacyFlatImgMiddleware(uploadsDir: string, imgDir: string): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const raw = String(req.originalUrl || req.url || '').split('?')[0];
    const seg = raw.replace(/^\/img\/?/i, '').replace(/^\/+/, '');
    if (!seg) return next();
    const abs = resolveLegacyFlatImgFilePath(uploadsDir, imgDir, seg);
    if (!abs) return next();
    res.sendFile(abs, (err) => {
      if (err) next(err);
    });
  };
}

/**
 * URL antiga `/img/miner/X.webp` (ou pasta PT) após o ficheiro ter sido
 * reclassificado para `rack/`/`battery/`/… — resolve pelo basename em todas
 * as pastas canónicas.
 */
function createCatalogRelocateFallbackMiddleware(uploadsDir: string, imgDir: string): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const raw = String(req.originalUrl || req.url || '').split('?')[0];
    const rel = raw.replace(/^\/img\/?/i, '').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) return next();
    const parts = rel.split('/').filter(Boolean);
    if (parts.length !== 2) return next();
    const [sub, basename] = parts;
    if (!CATALOG_SUB_SET.has(sub)) return next();
    const direct = path.join(imgDir, sub, basename);
    try {
      if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return next();
    } catch {
      /* procura noutro sítio */
    }
    const aliased = IMG_LEGACY_FOLDER_ALIASES[sub];
    if (aliased) {
      const alt = path.join(imgDir, aliased, basename);
      try {
        if (fs.existsSync(alt) && fs.statSync(alt).isFile()) {
          return res.sendFile(path.resolve(alt), (err) => {
            if (err) next(err);
          });
        }
      } catch {
        /* continua */
      }
    }
    const hit = resolveLegacyFlatImgFilePath(uploadsDir, imgDir, basename);
    if (!hit) return next();
    res.sendFile(hit, (err) => {
      if (err) next(err);
    });
  };
}

/**
 * Se a URL pedir `.png/.jpg/.gif` e o ficheiro já só existir como `.webp`, serve o webp
 * (rotas/BD antigas continuam a funcionar após conversão manual/futura).
 */
function createWebpExtFallbackMiddleware(uploadsDir: string, imgDir: string): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const raw = String(req.originalUrl || req.url || '').split('?')[0];
    const rel = raw.replace(/^\/img\/?/i, '').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) return next();
    const ext = path.extname(rel).toLowerCase();
    if (!isConvertibleRasterExt(ext)) return next();
    const candidates = [path.join(imgDir, rel), path.join(uploadsDir, rel), path.join(uploadsDir, path.basename(rel))];
    for (const abs of candidates) {
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return next();
      } catch {
        /* tenta o webp mesmo assim */
      }
      const webpAbs = webpSiblingPath(abs);
      try {
        if (fs.existsSync(webpAbs) && fs.statSync(webpAbs).isFile()) {
          res.type('image/webp');
          return res.sendFile(webpAbs, (err) => {
            if (err) next(err);
          });
        }
      } catch {
        /* continua */
      }
    }
    return next();
  };
}

export function mountImageStaticMiddleware(app: Express, uploadsDir: string, imgDir: string): void {
  app.use('/img', createLegacyFlatImgMiddleware(uploadsDir, imgDir));
  app.use('/img', createCatalogRelocateFallbackMiddleware(uploadsDir, imgDir));
  app.use('/img', createWebpExtFallbackMiddleware(uploadsDir, imgDir));
  app.use('/img', express.static(uploadsDir));
  app.use('/img', express.static(imgDir));
}

/** Organiza ficheiros soltos na raiz de `IMG_DIR` no arranque (um único worker em cluster). */
export function runImageRootStartupOrganizeIfEnabled(imgDir: string): void {
  try {
    const skip = String(process.env.SKIP_IMG_AUTO_ORGANIZE || '') === '1';
    const soleProcessOrFirstClusterWorker = !cluster.isWorker || (cluster.worker != null && cluster.worker.id === 1);
    if (skip || !soleProcessOrFirstClusterWorker) return;
    const n = organizeLooseFilesInImgRoot(imgDir);
    if (n > 0) {
      console.log(`[img] Organização automática: ${n} ficheiro(s) na raiz de IMG_DIR movidos para subpastas.`);
    }
  } catch (e) {
    console.warn('[img] organizeLooseFilesInImgRoot:', e instanceof Error ? e.message : String(e));
  }
}
