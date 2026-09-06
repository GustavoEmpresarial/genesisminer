/**
 * Gestão admin do catálogo de caixas (`/api/admin/loot-boxes`) e inventário
 * do jogador (`/api/admin/user-boxes`, `/api/admin/delete-user-box`).
 *
 * Catálogo: legacy/backend/controllers/lootBoxController.ts (`registerLootBoxAdminRoutes`).
 * Inventário: legacy/backend/server.ts (~3175–3239). Rotas player-facing
 * (`/api/loot-boxes/*`) são v1, superseded por `modules/lucky-boxes/`.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { respondIfHttpControlledError, sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { deleteLootBoxAdmin, parseLootBoxId, upsertLootBoxCatalog } from '../services/catalog.js';
import { listLootBoxRedemptions } from '../services/redemptions.js';
import { deleteUserUnopenedBox, listUserUnopenedBoxes } from '../services/user-inventory.js';

export type LootBoxAdminModuleDeps = { isAdmin: RequestHandler };

const HTTP_BAD_REQUEST = 400;

function isBrokenOnlyFlag(raw: unknown): boolean {
  const s = String(raw ?? '').toLowerCase();
  return raw === '1' || raw === 1 || s === 'true' || s === 'yes' || s === 'on';
}

function queryEmail(raw: unknown): unknown {
  return Array.isArray(raw) ? raw[0] : raw;
}

export function registerLootBoxAdminModuleRoutes(app: Express, deps: LootBoxAdminModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/loot-box-redemptions/:boxId', isAdmin, async (req: Request, res: Response) => {
    const boxId = parseLootBoxId(req.params.boxId);
    if (!boxId) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'ID da caixa inválido.' });
      return;
    }
    try {
      const rows = await listLootBoxRedemptions(boxId);
      res.json(rows);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      console.error('[GET /api/admin/loot-box-redemptions/:boxId] Fail:', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/loot-box-redemptions/:boxId', e, 'Falha ao listar resgates da caixa.');
    }
  });

  app.get('/api/admin/user-boxes', isAdmin, async (req: Request, res: Response) => {
    try {
      const payload = await listUserUnopenedBoxes(queryEmail(req.query.email));
      res.json(payload);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      console.error('[GET /api/admin/user-boxes] Fail:', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/user-boxes', e, 'Falha ao listar caixas do utilizador.');
    }
  });

  app.post('/api/admin/delete-user-box', isAdmin, async (req: Request, res: Response) => {
    try {
      const payload = await deleteUserUnopenedBox(req.body?.email, req.body?.boxId);
      res.json(payload);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      console.error('[POST /api/admin/delete-user-box] Fail:', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/delete-user-box', e, 'Falha ao apagar caixa do inventário.');
    }
  });

  app.post('/api/admin/loot-boxes', isAdmin, async (req: Request, res: Response) => {
    let boxes: unknown[];
    let replaceCatalog = false;
    if (Array.isArray(req.body)) {
      boxes = req.body;
    } else if (req.body && typeof req.body === 'object' && Array.isArray((req.body as { boxes?: unknown }).boxes)) {
      boxes = (req.body as { boxes: unknown[] }).boxes;
      replaceCatalog = (req.body as { replaceCatalog?: unknown }).replaceCatalog === true;
    } else {
      res.status(HTTP_BAD_REQUEST).json({ error: 'Body inválido: use { boxes: [], replaceCatalog?: boolean } ou um array (legado).' });
      return;
    }

    try {
      const warnings = await upsertLootBoxCatalog(boxes as Parameters<typeof upsertLootBoxCatalog>[0], replaceCatalog);
      res.json(warnings.length > 0 ? { ok: true, warnings } : { ok: true });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      console.error('[POST /api/admin/loot-boxes] Fail:', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/loot-boxes', e, 'Falha ao processar o pedido.');
    }
  });

  app.delete('/api/admin/loot-boxes/:boxId', isAdmin, async (req: Request, res: Response) => {
    const boxId = parseLootBoxId(req.params.boxId);
    if (!boxId) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'ID da caixa inválido.' });
      return;
    }
    const brokenOnly = isBrokenOnlyFlag(req.query.brokenOnly);

    try {
      const { boxName, summary } = await deleteLootBoxAdmin(boxId, brokenOnly);
      console.log('[LootBoxAdminDelete]', { boxId, boxName, brokenOnly, ...summary });
      res.json({ ok: true, summary });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      console.error('[LootBoxAdminDelete] Error:', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'DELETE /api/admin/loot-boxes/:boxId', e, 'Falha ao apagar caixa.');
    }
  });
}
