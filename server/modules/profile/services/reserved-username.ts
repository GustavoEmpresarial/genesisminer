/**
 * Nomes reservados / equipa e limpeza de caracteres invisíveis em username de perfil.
 *
 * Migrado de legacy/backend/models/profileUsernameReserved.ts. Regex de zero-width
 * construído por code point (mesmo motivo de `shared/utils/safe-text.ts`) em vez de
 * escape literal — evita depender de caractere invisível sobrevivendo no `.ts`.
 */
const ZERO_WIDTH_SPACE_START = 0x200b;
const ZERO_WIDTH_JOINER_END = 0x200d;
const BOM = 0xfeff;

const INVISIBLE_CHARS_PATTERN = new RegExp(
  '[' + String.fromCharCode(ZERO_WIDTH_SPACE_START) + '-' + String.fromCharCode(ZERO_WIDTH_JOINER_END) + String.fromCharCode(BOM) + ']',
  'g'
);

const RESERVED = new Set(
  [
    'admin', 'administrator', 'support', 'suporte', 'root', 'genesis', 'genesisminer',
    'genesis-miner', 'minestation', 'staff', 'moderator', 'mod', 'official', 'system',
    'equipe', 'team', 'helpdesk'
  ].map((s) => s.toLowerCase())
);

export function isReservedProfileUsername(username: string): boolean {
  const t = String(username || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return true;
  const compact = t.replace(/[\s_-]/g, '');
  if (RESERVED.has(t) || RESERVED.has(compact)) return true;
  for (const r of RESERVED) {
    if (t.startsWith(`${r} `) || t.startsWith(`${r}_`) || t.startsWith(`${r}-`)) return true;
  }
  return false;
}

export function stripInvisibleUsernameChars(raw: string): string {
  return String(raw || '').replace(INVISIBLE_CHARS_PATTERN, '');
}
