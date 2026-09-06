/**
 * Carrega variáveis de ambiente antes do resto do servidor.
 * Deve ser o primeiro import do processo (ver server/bootstrap/index.ts).
 *
 * Migrado de legacy/backend/utils/loadEnv.ts.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/bootstrap/env.ts -> raiz do repo (current/)
export const repoRoot = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(repoRoot, '.env') });
