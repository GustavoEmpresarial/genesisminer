/**
 * Parser de cookies cru a partir do header `Cookie` — sem depender de `cookie-parser`
 * como middleware global (só quem precisa chama).
 *
 * Migrado de legacy/backend/server.ts (função `parseCookies` inline no bootstrap).
 */
import type { Request } from 'express';

/**
 * Parseia o header `Cookie` bruto em `{ nome: valor }`.
 * Não faz `decodeURIComponent` nos valores — devolve exatamente o que veio
 * no header, cabe a quem consome decodificar se precisar.
 */
export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie || '';
  return header
    .split(';')
    .map((v) => v.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, cur) => {
      const i = cur.indexOf('=');
      if (i > 0) acc[cur.slice(0, i)] = cur.slice(i + 1);
      return acc;
    }, {});
}
