/**
 * Registro de movimentação de inventário (compra, instalação, retirada,
 * merge de itens, etc.) na tabela `inventory_movements` — trilha de
 * auditoria genérica, não específica de um módulo (consumida hoje por
 * `modules/merge`, `modules/inventory` e o audit trail de
 * `modules/admin/user-audit`).
 *
 * Deliberadamente "best-effort": uma falha ao gravar o registro de
 * auditoria não deve derrubar a operação de jogo que a originou (comprar
 * um item não pode falhar porque o log de auditoria da compra falhou) —
 * ver {@link recordInventoryMovement}.
 *
 * Migrado de legacy/backend/modules/inventory/inventory.audit.ts (verbatim) —
 * já era um utilitário genérico no legado, não específico de um módulo.
 */
import { prisma } from '../../core/database/prisma.js';

export type InventoryMovementInput = {
  userId: number;
  /** Identifica o tipo de movimento (ex.: `'purchase'`, `'merge_consume'`,
   *  `'install'`) — truncado a {@link ACTION_MAX_LENGTH}. */
  action: string;
  catalogItemId?: string | null;
  instanceId?: string | null;
  quantityBefore?: number | null;
  quantityAfter?: number | null;
  /** Objeto pequeno (sem secrets/PII) com contexto adicional do movimento;
   *  gravado como string JSON, truncada a {@link META_MAX_LENGTH}. */
  meta?: Record<string, unknown> | null;
};

/** Teto de tamanho do JSON de `meta` gravado — protege contra um chamador
 *  passar payload grande demais (a coluna é para contexto de auditoria
 *  pontual, não um blob de dados). */
const META_MAX_LENGTH = 4000;

/** Teto de tamanho de `action`. */
const ACTION_MAX_LENGTH = 64;

/** Teto de tamanho de `catalogItemId`/`instanceId`. */
const ID_MAX_LENGTH = 200;

/**
 * Registra um movimento de inventário. Não lança: em caso de `userId`/
 * `action` inválidos, não grava nada silenciosamente (validação de entrada,
 * não é erro operacional); em caso de falha na escrita ao banco, captura a
 * exceção e só emite `console.warn` — a auditoria é um efeito colateral
 * best-effort, o fluxo principal (a operação de jogo que gerou este
 * movimento) já deve ter sido concluído/persistido antes desta chamada e
 * não deve ser revertido só porque o log de auditoria falhou.
 *
 * @param input.userId - Deve ser um inteiro positivo; qualquer outro valor
 *   (incluindo `NaN`/negativo/zero) faz a função retornar sem gravar.
 * @param input.action - Vazio (após trim) faz a função retornar sem gravar.
 */
export async function recordInventoryMovement(input: InventoryMovementInput): Promise<void> {
  const userId = Number(input.userId);
  if (!Number.isFinite(userId) || userId <= 0) return;
  const action = String(input.action || '').trim().slice(0, ACTION_MAX_LENGTH);
  if (!action) return;

  let metaJson: string | null = null;
  if (input.meta && typeof input.meta === 'object') {
    try {
      metaJson = JSON.stringify(input.meta).slice(0, META_MAX_LENGTH);
    } catch {
      // `JSON.stringify` pode lançar em estrutura circular; auditoria sem
      // `meta` é preferível a perder o registro do movimento inteiro.
      metaJson = null;
    }
  }

  try {
    await prisma.inventory_movements.create({
      data: {
        user_id: userId,
        action,
        catalog_item_id: input.catalogItemId != null ? String(input.catalogItemId).slice(0, ID_MAX_LENGTH) : null,
        instance_id: input.instanceId != null ? String(input.instanceId).slice(0, ID_MAX_LENGTH) : null,
        quantity_before:
          input.quantityBefore != null && Number.isFinite(input.quantityBefore) ? input.quantityBefore : null,
        quantity_after:
          input.quantityAfter != null && Number.isFinite(input.quantityAfter) ? input.quantityAfter : null,
        meta: metaJson,
        created_at: BigInt(Date.now())
      }
    });
  } catch (e) {
    console.warn('[inventory_movements] falha ao gravar:', e instanceof Error ? e.message : String(e));
  }
}
