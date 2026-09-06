/**
 * Migrado de legacy/backend/lib/supportUploadLimits.ts + a constante
 * `SUPPORT_ALLOWED_EXT` de lib/supportTicketAttachments.ts. Os mesmos limites
 * (`SUPPORT_UPLOAD_MAX_BYTES`/`SUPPORT_UPLOAD_MAX_FILES`) definem o upload de
 * anexos do jogador, hoje servido por genesis-api (ver DECISIONS.md #45).
 */
const BYTES_PER_KB = 1024;
const KB_PER_MB = 1024;

const SUPPORT_UPLOAD_MAX_MB = 12;

/** Alinhado com o multer do legado — informativo até o upload ser portado. */
export const SUPPORT_UPLOAD_MAX_BYTES = SUPPORT_UPLOAD_MAX_MB * KB_PER_MB * BYTES_PER_KB;
export const SUPPORT_UPLOAD_MAX_FILES = 5;

export const SUPPORT_ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.mov']);
