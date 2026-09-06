/**
 * Espelho não sensível em disco (`storage/`) para auditoria/cópia de trabalho.
 * Nunca grava o refresh token em claro — apenas metadados agregados.
 *
 * Migrado de legacy/backend/src/auth/storageMirror.ts. Simplificado: o legado tinha
 * `getBackendRootFromSrcAuthFile()` (lib/backendRoot.ts) só pra descobrir se o arquivo
 * rodava a partir de `src/` ou de `dist/` compilado — gambiarra que existia por causa do
 * problema descrito em docs/architecture/DECISIONS.md #1 (imports de `dist/`). Aqui isso
 * não existe: o caminho de `storage/` é fixo a partir da raiz do projeto (`current/`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../../core/database/prisma.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/modules/auth/storage-mirror.ts -> current/ (raiz do projeto)
const STORAGE_DIR = path.resolve(__dirname, '..', '..', '..', 'storage');
const STORAGE_DIR_MODE = 0o700;
const STORAGE_FILE_MODE = 0o600;

export function ensureStorageDir(): void {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: STORAGE_DIR_MODE });
  } catch {
    /* ignore */
  }
}

export async function writeJwtRefreshSnapshot(): Promise<void> {
  ensureStorageDir();
  try {
    const activeRefreshTokens = await prisma.jwt_refresh_tokens.count({
      where: {
        revoked_at: null,
        expires_at: { gt: BigInt(Date.now()) }
      }
    });
    const snap = {
      updatedAt: Date.now(),
      activeRefreshTokens
    };
    const target = path.join(STORAGE_DIR, 'jwt_refresh_index.json');
    const JSON_INDENT = 2;
    fs.writeFileSync(target, JSON.stringify(snap, null, JSON_INDENT), { encoding: 'utf8', mode: STORAGE_FILE_MODE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[JWT] Falha ao escrever espelho em storage:', msg);
  }
}
