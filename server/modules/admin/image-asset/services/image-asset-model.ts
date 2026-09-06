/**
 * Classificação/organização de imagens sob `IMG_DIR` (nome → subpasta canónica),
 * parsing de upload por data URL, nomes seguros de ficheiro.
 *
 * Pastas canónicas em **inglês** (DECISIONS #84). Aliases PT (`baterias`, …)
 * existem só como symlinks no disco para URLs antigas.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Pastas canónicas sob `storage/media-seed/` (organização automática). */
export const IMG_CANONICAL_SUBFOLDERS = [
  'miner',
  'rack',
  'fan',
  'chip',
  'battery',
  'charger',
  'coin',
  'support',
  'partner',
  'favicon',
  'landing',
  'uploads'
] as const;

export type ImgCanonicalSubfolder = (typeof IMG_CANONICAL_SUBFOLDERS)[number];

/** Destinos permitidos em upload admin com `assetFolder`. */
export const IMG_ADMIN_TARGET_SUBFOLDERS = [
  'miner',
  'rack',
  'fan',
  'chip',
  'battery',
  'charger',
  'coin',
  'partner',
  'favicon',
  'landing'
] as const;

export type ImgAdminTargetSubfolder = (typeof IMG_ADMIN_TARGET_SUBFOLDERS)[number];

export const IMG_ADMIN_TARGET_SUBFOLDER_SET = new Set<string>(IMG_ADMIN_TARGET_SUBFOLDERS);

/**
 * Ordem para resolver URLs flat `/img/<basename>`: uploads runtime primeiro,
 * depois catálogo fino.
 */
export const IMG_FLAT_NAME_LOOKUP_SUBFOLDERS: readonly ImgCanonicalSubfolder[] = [
  'uploads',
  'support',
  'miner',
  'rack',
  'fan',
  'chip',
  'battery',
  'charger',
  'coin',
  'partner',
  'favicon',
  'landing'
];

/** Aliases legados (PT / plurais) → pasta canónica EN. Só para docs/migração. */
export const IMG_LEGACY_FOLDER_ALIASES: Readonly<Record<string, ImgCanonicalSubfolder>> = {
  baterias: 'battery',
  batteries: 'battery',
  carregadores: 'charger',
  chargers: 'charger',
  moedas: 'coin',
  coins: 'coin',
  parceiros: 'partner',
  partners: 'partner',
  racks: 'rack',
  fans: 'fan',
  chips: 'chip',
  miners: 'miner'
};

const FLAT_MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);

const MOVEABLE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.mov', '.ico']);

const ORIGINAL_NAME_BASE_MAX_LENGTH = 32;

/**
 * Decide a subpasta canónica EN a partir do NOME do ficheiro (heurística).
 * Mais específico primeiro; default `'miner'`.
 */
export function classifyImageSubfolder(filename: string): ImgCanonicalSubfolder {
  const lower = filename.toLowerCase();

  if (lower.startsWith('ad-')) return 'uploads';
  if (lower.startsWith('support-') || lower.startsWith('support-reply-')) return 'support';

  if (
    lower.includes('genesis-miner-logo') ||
    lower.includes('genesis_miner_logo') ||
    (lower.includes('favicon') && MOVEABLE_EXT.has(path.extname(lower)))
  ) {
    return 'favicon';
  }

  if (lower.includes('landing')) return 'landing';

  if (
    lower.includes('parceiro') ||
    lower.includes('partner') ||
    lower.includes('blockminer') ||
    lower.includes('emblema_parceiro')
  ) {
    return 'partner';
  }

  if (lower.includes('rack') || lower.includes('armario') || lower.includes('chassis')) {
    return 'rack';
  }

  if (lower.includes('fan') || lower.includes('cooler') || lower.includes('ventil')) {
    return 'fan';
  }

  if (
    lower.includes('ai_opt') ||
    lower.includes('ai-opt') ||
    lower.includes('chip') ||
    lower.includes('multiplier') ||
    lower.includes('optimiz')
  ) {
    return 'chip';
  }

  if (
    lower.includes('carregador') ||
    lower.includes('charger') ||
    lower.includes('wiring') ||
    lower.includes('circuit') ||
    lower.includes('genesiscircuit')
  ) {
    return 'charger';
  }

  const batteryLike =
    lower.includes('connected_battery') ||
    lower.includes('battery_pack') ||
    lower.includes('battery') ||
    (lower.includes('bateria') && !lower.includes('carregador')) ||
    lower.includes('kwh') ||
    (/\d+wh/.test(lower) && /\.(png|gif|jpe?g|webp)$/i.test(lower));
  if (batteryLike && !lower.includes('gpu') && !lower.includes('video_card')) {
    return 'battery';
  }

  if (
    lower.includes('usdc') ||
    lower.includes('whale') ||
    lower.includes('moeda') ||
    lower.includes('coin') ||
    lower.includes('/moedas/')
  ) {
    return 'coin';
  }

  return 'miner';
}

/**
 * Move ficheiros de media ainda na **raiz** de `imgRootDir` para a subpasta adequada.
 * @returns número de ficheiros movidos
 */
export function organizeLooseFilesInImgRoot(imgRootDir: string): number {
  let moved = 0;
  for (const name of fs.readdirSync(imgRootDir)) {
    if (name.startsWith('.')) continue;
    const src = path.join(imgRootDir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(src);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (!MOVEABLE_EXT.has(ext)) continue;
    const sub = classifyImageSubfolder(name);
    const destDir = path.join(imgRootDir, sub);
    try {
      fs.mkdirSync(destDir, { recursive: true });
    } catch {
      /* idempotente */
    }
    const dest = path.join(destDir, name);
    if (path.dirname(src) === destDir) continue;
    try {
      fs.renameSync(src, dest);
      moved += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[image-asset-model] não moveu', name, msg);
    }
  }
  return moved;
}

function realpathOrNull(abs: string): string | null {
  try {
    return fs.realpathSync(abs);
  } catch {
    return null;
  }
}

function isPathInsideDir(inner: string, outer: string): boolean {
  const a = realpathOrNull(inner);
  const b = realpathOrNull(outer);
  if (!a || !b) return false;
  const bSep = b.endsWith(path.sep) ? b : b + path.sep;
  return a === b || a.startsWith(bSep);
}

/**
 * `sourceDir` é o uploads runtime (`IMG_UPLOADS_DIR` / `imgRootDir/uploads` após
 * resolver o symlink `media-seed/uploads` → `../uploads`)? Nesse caso **não**
 * minerar o catálogo a partir daí — `support-*` / `ad-*` / resto ficam em uploads.
 */
function isRuntimeUploadsDirectory(sourceDir: string, imgRootDir: string): boolean {
  const sourceReal = realpathOrNull(sourceDir);
  const uploadsViaCatalog = realpathOrNull(path.join(imgRootDir, 'uploads'));
  return Boolean(sourceReal && uploadsViaCatalog && sourceReal === uploadsViaCatalog);
}

/**
 * Reclassifica ficheiros **dentro** de pastas de catálogo (ex.: `miner/` →
 * `rack/`/`charger/`/…) para as subpastas EN finas. Não desce a
 * `chat-audio` / `partner-avatars`. Devolve quantos moveu.
 *
 * Sem caller em startup/runtime (só export). Contrato (assinatura + retorno)
 * inalterado. Fontes fora do catálogo (incl. `uploads/` runtime) são no-op:
 * uploads ≠ catálogo — `support-*` não volta a `media-seed/support` por nome.
 */
export function reclassifyFilesInDirectory(
  sourceDir: string,
  imgRootDir: string,
  opts?: { skipDirNames?: ReadonlySet<string> }
): number {
  const skip = opts?.skipDirNames ?? new Set(['chat-audio', 'partner-avatars']);
  if (!fs.existsSync(sourceDir)) return 0;
  if (isRuntimeUploadsDirectory(sourceDir, imgRootDir)) return 0;
  if (!isPathInsideDir(sourceDir, imgRootDir)) return 0;
  let moved = 0;
  for (const name of fs.readdirSync(sourceDir)) {
    if (name.startsWith('.')) continue;
    if (skip.has(name)) continue;
    const src = path.join(sourceDir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(src);
    } catch {
      continue;
    }
    if (st.isDirectory()) continue;
    if (!st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (!MOVEABLE_EXT.has(ext)) continue;
    const sub = classifyImageSubfolder(name);
    const destDir = path.join(imgRootDir, sub);
    const dest = path.join(destDir, name);
    if (path.resolve(src) === path.resolve(dest)) continue;
    try {
      fs.mkdirSync(destDir, { recursive: true });
      if (fs.existsSync(dest)) continue;
      fs.renameSync(src, dest);
      moved += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[image-asset-model] reclassify skip', name, msg);
    }
  }
  return moved;
}

export function sanitizeOriginalNameBase(originalName: unknown): string {
  const raw = originalName != null && typeof originalName !== 'object' ? String(originalName) : 'image';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, ORIGINAL_NAME_BASE_MAX_LENGTH) || 'image';
}

const RANDOM_SUFFIX_RADIX = 36;
const RANDOM_SUFFIX_SLICE_START = 2;
const RANDOM_SUFFIX_SLICE_END = 8;

export function buildStoredUploadFilename(safeBase: string, ext: string): string {
  return `${Date.now()}_${Math.random().toString(RANDOM_SUFFIX_RADIX).slice(RANDOM_SUFFIX_SLICE_START, RANDOM_SUFFIX_SLICE_END)}_${safeBase}${ext}`;
}

/** Resolve `basename` dentro de `dir`; se não existir com a extensão pedida, tenta o irmão `.webp`. */
function tryResolveExistingFile(dir: string, basename: string): string | null {
  const fp = path.join(dir, basename);
  try {
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return path.resolve(fp);
  } catch {
    /* continua */
  }
  const ext = path.extname(basename).toLowerCase();
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif') {
    const webpName = basename.slice(0, -ext.length) + '.webp';
    const wp = path.join(dir, webpName);
    try {
      if (fs.existsSync(wp) && fs.statSync(wp).isFile()) return path.resolve(wp);
    } catch {
      /* continua */
    }
  }
  return null;
}

export function resolveLegacyFlatImgFilePath(uploadsDir: string, imgDir: string, flatSegment: string): string | null {
  if (!flatSegment || flatSegment.includes('/') || flatSegment.includes('..')) return null;
  const ext = path.extname(flatSegment).toLowerCase();
  if (!FLAT_MEDIA_EXT.has(ext)) return null;
  const basename = path.basename(flatSegment);
  if (basename !== flatSegment) return null;
  for (const sub of IMG_FLAT_NAME_LOOKUP_SUBFOLDERS) {
    const dir = sub === 'uploads' ? uploadsDir : path.join(imgDir, sub);
    const hit = tryResolveExistingFile(dir, basename);
    if (hit) return hit;
  }
  return null;
}
