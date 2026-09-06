/**
 * Leitura de `inventory_movements` (gravado por `shared/audit/inventory-movement.ts`)
 * para o painel admin.
 *
 * Migrado de legacy/backend/services/adminUserInventoryAudit.service.ts (verbatim).
 *
 * ⚠️ Corte de escopo: as outras 3 rotas do controller admin de origem
 * (`GET /api/admin/user-activity`, `.../session-snapshots`, `.../account-trace`)
 * dependem de infraestrutura ainda não migrada — `lib/mongoLogs.ts` (listagem de
 * activity logs Mongo), `lib/activityEventFormatter.ts` (formatação/filtro de
 * eventos), `services/playerStateSnapshot.service.ts` (diff de snapshot) e o
 * próprio `services/adminUserAccountTrace.service.ts` (890 linhas, cruza todas
 * essas dependências + mais). Só `listUserInventoryAudit` é autocontido (só usa
 * `inventory_movements`/`upgrades`, ambos já em `current/`) — ver DECISIONS.md.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../core/database/prisma.js';
import { clamp } from '../../../../shared/utils/clamp.js';

/** Maior valor de `page` aceite — só um teto de sanidade, não há tantas páginas reais. */
const PAGE_MAX = 99_999;
/** Maior `limit` (itens por página) aceite por pedido. */
const LIMIT_MAX = 200;

/**
 * Faz o parse de um filtro de data vindo da query string (`from`/`to`), aceitando
 * tanto epoch em milissegundos (string só de dígitos) quanto uma data
 * parseável por `Date.parse` (ISO 8601, etc.).
 *
 * @param v - Valor bruto da query (`unknown` porque o Express não garante tipo).
 * @returns Epoch em ms, ou `null` se `v` for `null`/`undefined` ou não for
 *   reconhecível como data/epoch.
 */
function parseMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Faz o parse dos parâmetros `from`/`to` de `GET /api/admin/users/:userId/inventory-audit`
 * num intervalo de datas em epoch-ms, usado no filtro SQL de `listUserInventoryAudit`.
 *
 * @param fromRaw - Valor bruto de `req.query.from`.
 * @param toRaw - Valor bruto de `req.query.to`.
 * @returns `{ fromMs, toMs }`, cada um `null` quando ausente/inválido (sem filtro nesse lado).
 */
export function parseInventoryAuditRange(fromRaw: unknown, toRaw: unknown): { fromMs: number | null; toMs: number | null } {
  return { fromMs: parseMs(fromRaw), toMs: parseMs(toRaw) };
}

export type InventoryAuditRow = {
  id: string;
  createdAtMs: number;
  action: string;
  catalogItemId: string | null;
  itemName: string | null;
  instanceId: string | null;
  quantityBefore: number | null;
  quantityAfter: number | null;
  delta: number | null;
  source: string;
  summary: string;
};

type RawAuditRow = {
  id: string;
  action: string;
  catalog_item_id: string | null;
  instance_id: string | null;
  quantity_before: number | null;
  quantity_after: number | null;
  meta: string | null;
  created_at: bigint | number;
  upgrade_name: string | null;
};

/**
 * Converte uma linha bruta de `inventory_movements` (+ nome do upgrade via join)
 * no formato exposto pelo endpoint admin: calcula o delta, escolhe um nome de
 * exibição e monta um resumo textual pronto pra UI.
 *
 * @param r - Linha crua vinda do `$queryRaw` (tipos ainda em bigint/string do Postgres).
 * @returns Linha normalizada com `delta`/`summary` calculados; `source` cai de
 *   volta para `r.action` quando `meta` não tem `source` ou não é JSON válido.
 */
function mapAuditRow(r: RawAuditRow): InventoryAuditRow {
  const before = r.quantity_before != null ? Number(r.quantity_before) : null;
  const after = r.quantity_after != null ? Number(r.quantity_after) : null;
  const delta = before != null && after != null ? after - before : null;
  const itemName = r.upgrade_name || r.catalog_item_id;
  let source = r.action;
  try {
    if (r.meta) {
      const parsed = JSON.parse(r.meta) as { source?: string };
      if (parsed.source) source = String(parsed.source);
    }
  } catch {
    /* mantém o action como source se o meta não for JSON válido */
  }
  const summary = delta != null && itemName ? `${itemName}: ${before} → ${after} (Δ ${delta > 0 ? '+' : ''}${delta})` : r.action;
  return {
    id: r.id,
    createdAtMs: Number(r.created_at),
    action: r.action,
    catalogItemId: r.catalog_item_id,
    itemName,
    instanceId: r.instance_id,
    quantityBefore: before,
    quantityAfter: after,
    delta,
    source,
    summary
  };
}

/**
 * Lista movimentos de inventário (`inventory_movements`) de um jogador para o
 * painel de auditoria admin, com paginação e filtros opcionais de data e de
 * "só perdas" (`quantity_after < quantity_before`).
 *
 * `userId` é a única entrada que decide o escopo dos dados (WHERE user_id);
 * `page`/`limit` são sempre normalizados via `clamp` antes de virar
 * OFFSET/LIMIT, então nunca geram uma query com paginação absurda mesmo que
 * o caller passe valores fora do intervalo esperado.
 *
 * @param params.userId - Id do jogador auditado.
 * @param params.fromMs - Epoch-ms inclusive do início do intervalo (opcional).
 * @param params.toMs - Epoch-ms inclusive do fim do intervalo (opcional).
 * @param params.page - Página 1-based (clampada em `[1, PAGE_MAX]`).
 * @param params.limit - Itens por página (clampado em `[1, LIMIT_MAX]`).
 * @param params.lossesOnly - Quando `true`, só devolve movimentos onde a
 *   quantidade diminuiu.
 * @returns `total` (contagem sem paginação), `page`/`limit` já normalizados
 *   e `rows` da página pedida, mais recentes primeiro.
 */
export async function listUserInventoryAudit(params: { userId: number; fromMs?: number | null; toMs?: number | null; page: number; limit: number; lossesOnly?: boolean }): Promise<{
  total: number;
  page: number;
  limit: number;
  rows: InventoryAuditRow[];
}> {
  const uid = Math.floor(params.userId);
  const page = clamp(params.page, 1, PAGE_MAX);
  const limit = clamp(params.limit, 1, LIMIT_MAX);
  const offset = (page - 1) * limit;

  const fromClause = params.fromMs != null ? Prisma.sql`AND created_at >= ${BigInt(Math.floor(params.fromMs))}` : Prisma.empty;
  const toClause = params.toMs != null ? Prisma.sql`AND created_at <= ${BigInt(Math.floor(params.toMs))}` : Prisma.empty;
  const lossesClause = params.lossesOnly ? Prisma.sql`AND quantity_after IS NOT NULL AND quantity_before IS NOT NULL AND quantity_after < quantity_before` : Prisma.empty;

  const totalRows = await prisma.$queryRaw<Array<{ total: bigint | number }>>`
    SELECT COUNT(*)::bigint AS total FROM inventory_movements WHERE user_id = ${uid} ${fromClause} ${toClause} ${lossesClause}
  `;
  const total = Number(totalRows[0]?.total ?? 0);

  const rows = await prisma.$queryRaw<RawAuditRow[]>`
    SELECT
        m.id::text, m.action, m.catalog_item_id, m.instance_id, m.quantity_before, m.quantity_after, m.meta, m.created_at,
        u.name AS upgrade_name
      FROM inventory_movements m
      LEFT JOIN upgrades u ON u.id = m.catalog_item_id
      WHERE m.user_id = ${uid} ${fromClause} ${toClause} ${lossesClause}
      ORDER BY m.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
  `;

  return { total, page, limit, rows: rows.map(mapAuditRow) };
}
