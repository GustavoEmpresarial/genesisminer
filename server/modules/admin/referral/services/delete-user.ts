/**
 * Exclusão de conta em cascata (limpa FKs sem `ON DELETE CASCADE` antes de apagar
 * `users`). Migrado de legacy/backend/server.ts:6764 (`deleteUserByEmail`) — nunca
 * tinha sido extraída do monólito; só usada aqui por `POST /api/admin/referrals/network-delete`.
 *
 * Operação destrutiva: apaga dados de produção em permanência. Chamador decide o
 * envelope transacional — se `client` vier `null`, esta função abre/fecha a sua
 * própria transação; se vier um client já em transação (ex.: exclusão em rede,
 * vários utilizadores na mesma transação), reusa-o e deixa o chamador decidir
 * commit/rollback.
 */
import type { PoolClient } from 'pg';
import pool from '../../../../core/database/pool.js';
import { callHardwareWipeUser } from '../../../hardware/services/hardware-client.js';
import { callAuthSessionDeleteByUser } from '../../../auth/services/auth-worker-client.js';

type PgQueryable = Pick<PoolClient, 'query'>;

export type DeleteUserByEmailResult = { ok: boolean; error?: string };

export async function deleteUserByEmail(email: string, client: PgQueryable | null): Promise<DeleteUserByEmailResult> {
  const dbClient: PgQueryable & { release?: () => void } = client ?? (await pool.connect());
  const wasOwner = !client;

  try {
    if (wasOwner) await dbClient.query('BEGIN');

    const trimmed = String(email || '').trim();
    if (!trimmed) {
      if (wasOwner) await dbClient.query('ROLLBACK');
      return { ok: false, error: 'Email inválido.' };
    }
    const lower = trimmed.toLowerCase();
    // Emails na BD podem ter maiúsculas diferentes; comparar sempre em minúsculas.
    let userRes = await dbClient.query('SELECT id, username, polygon_wallet, email FROM users WHERE lower(trim(email::text)) = $1', [lower]);
    // Duas contas com o mesmo e-mail ignorando maiúsculas: desambiguar pelo valor exacto vindo do painel.
    if ((userRes.rowCount ?? 0) > 1) {
      const exactRes = await dbClient.query('SELECT id, username, polygon_wallet, email FROM users WHERE lower(trim(email::text)) = $1 AND email = $2', [
        lower,
        trimmed
      ]);
      if (exactRes.rowCount === 1) {
        userRes = exactRes;
      } else {
        throw new Error('Existem várias contas com o mesmo e-mail (só difere maiúsculas). Corrige os e-mails na base de dados ou remove por ID.');
      }
    }

    if (userRes.rowCount === 0) {
      if (wasOwner) await dbClient.query('ROLLBACK');
      return { ok: false, error: 'Utilizador não encontrado.' };
    }

    const { id: uid, username, polygon_wallet: wallet } = userRes.rows[0] as { id: number; username: string | null; polygon_wallet: string | null };

    await callHardwareWipeUser({ userId: uid });

    // FKs sem ON DELETE CASCADE (bloqueiam DELETE em users se não limpar antes)
    await dbClient.query('DELETE FROM support_ticket_replies WHERE admin_user_id = $1', [uid]);
    await dbClient.query('DELETE FROM support_tickets WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM p2p_market_trade_history WHERE buyer_id = $1 OR seller_id = $1', [uid]);
    const wipe = await callAuthSessionDeleteByUser({ userId: uid });
    if (!wipe.ok) {
      throw new Error(wipe.error ?? 'auth session delete-by-user failed');
    }
    try {
      await dbClient.query('UPDATE partner_youtube_submissions SET reviewed_by = NULL WHERE reviewed_by = $1', [uid]);
      await dbClient.query('UPDATE partner_youtube_creator_profiles SET updated_by = NULL WHERE updated_by = $1', [uid]);
      await dbClient.query('UPDATE partner_youtube_manual_allowlist SET added_by = NULL WHERE added_by = $1', [uid]);
      await dbClient.query('DELETE FROM partner_youtube_manual_allowlist WHERE user_id = $1', [uid]);
    } catch (partnerErr) {
      const code = partnerErr && typeof partnerErr === 'object' && 'code' in partnerErr ? (partnerErr as { code?: string }).code : '';
      if (code !== '42P01') throw partnerErr;
    }

    // Delete in child-to-parent order (sessions wiped via genesis-auth)
    await dbClient.query('DELETE FROM referrals WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM player_news_submissions WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM admin_upgrade_purchases WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM season_purchases WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM user_rig_rooms WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM unopened_boxes WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM coin_balances WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM coin_withdrawals WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM withdrawal_requests WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM user_history_ips WHERE user_id = $1', [uid]);

    await dbClient.query('DELETE FROM player_listings WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM daily_actions WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM promo_code_redemptions WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM player_claimed_boxes WHERE user_id = $1', [uid]);
    await dbClient.query('DELETE FROM game_states WHERE user_id = $1', [uid]);

    // Handle tables linked by other identifiers
    if (username) await dbClient.query('DELETE FROM wheel_players WHERE username = $1', [username]);
    if (wallet) await dbClient.query('DELETE FROM nft_items WHERE owner_address = $1', [wallet]);

    // Finally delete the user
    await dbClient.query('DELETE FROM users WHERE id = $1', [uid]);

    if (wasOwner) await dbClient.query('COMMIT');
    return { ok: true };
  } catch (e) {
    if (wasOwner) await dbClient.query('ROLLBACK');
    throw e;
  } finally {
    if (wasOwner) dbClient.release?.();
  }
}
