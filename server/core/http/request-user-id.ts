/**
 * Extrai e valida `req.userId` (setado pelo middleware de auth) como um inteiro
 * positivo, ou `null` se ausente/inválido.
 *
 * Consolidado a partir de 18 cópias idênticas — cada controller portado tinha
 * sua própria função local `uidNum`/`uidOptional`/`uidRequired` (mesmo corpo,
 * só o nome variava), fiel ao legado, que já tinha essa mesma duplicação
 * copiada em cada `*.controller.ts`. Ver docs/architecture/DECISIONS.md.
 */
import type { Request } from 'express';

export function resolveRequestUserId(req: Request): number | null {
  const v = req.userId;
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
