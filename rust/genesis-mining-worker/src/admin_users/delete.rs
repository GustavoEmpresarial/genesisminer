//! `DELETE /api/user/:email` — Node `services/delete.ts` + `referral/services/delete-user.ts`.
//!
//! Destructive: rows disappear for good. The Node flow is `resolve → policy →
//! hardware wipe → cascade delete`, with the hardware wipe running in its own
//! transaction. genesis-api keeps that ordering by calling [`run_admin_delete_resolve`],
//! then the hardware wipe twin, then [`run_admin_delete_user`], which re-checks
//! the policy before touching anything.

use deadpool_postgres::{Pool, Transaction};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::warn;

use crate::config::WorkerConfig;
use crate::player_reads::{i32_cell, opt_string, PlayerReadError};
use crate::profile_writes::auth_client::{auth_revoke_refresh, auth_session_delete_by_user};

use super::{
    parse_admin_user_email, truthy_flag, AdminActor, CODE_CONFLICT, CODE_FORBIDDEN, CODE_NOT_FOUND,
    HTTP_CONFLICT, HTTP_FORBIDDEN, HTTP_NOT_FOUND,
};

const ERR_USER_NOT_FOUND: &str = "Utilizador não encontrado.";
const ERR_ADMIN_DELETE_SUPER_ONLY: &str =
    "Apenas super administradores podem excluir outras contas administrador.";
/// Node throws this message from `deleteUserByEmail`; the service maps it to 409.
const ERR_AMBIGUOUS_EMAIL: &str = "Existem várias contas com o mesmo e-mail (só difere maiúsculas). Corrige os e-mails na base de dados ou remove por ID.";

/// Postgres "relation does not exist" — Node swallows it for the optional
/// `partner_youtube_*` tables.
const PG_UNDEFINED_TABLE: &str = "42P01";

/// `DELETE /api/user/:email`. `email` still carries the raw path segment;
/// genesis-api percent-decodes it exactly like the Node controller.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUserDeleteRequest {
    pub email: String,
    #[serde(flatten)]
    pub actor: AdminActor,
}

struct ResolvedTarget {
    id: i32,
    username: Option<String>,
    wallet: Option<String>,
}

/// Node `deleteUserByEmail`'s lookup: match on the lowercased/trimmed address,
/// and disambiguate by the exact spelling the panel sent when case-only
/// duplicates exist.
async fn resolve_target<C: deadpool_postgres::GenericClient>(
    client: &C,
    email: &str,
) -> Result<ResolvedTarget, PlayerReadError> {
    let lower = email.to_lowercase();
    let mut rows = client
        .query(
            "SELECT id, username, polygon_wallet FROM users WHERE LOWER(BTRIM(email::text)) = $1",
            &[&lower],
        )
        .await?;
    if rows.len() > 1 {
        let exact = client
            .query(
                "SELECT id, username, polygon_wallet
                   FROM users
                  WHERE LOWER(BTRIM(email::text)) = $1 AND email = $2",
                &[&lower, &email],
            )
            .await?;
        if exact.len() == 1 {
            rows = exact;
        } else {
            return Err(PlayerReadError::controlled(
                HTTP_CONFLICT,
                ERR_AMBIGUOUS_EMAIL,
                CODE_CONFLICT,
            ));
        }
    }
    let Some(row) = rows.first() else {
        return Err(PlayerReadError::controlled(
            HTTP_NOT_FOUND,
            ERR_USER_NOT_FOUND,
            CODE_NOT_FOUND,
        ));
    };
    Ok(ResolvedTarget {
        id: i32_cell(row, "id"),
        username: opt_string(row, "username"),
        wallet: opt_string(row, "polygon_wallet"),
    })
}

/// Node `deleteAdminUserByEmail`'s guard: only super admins may delete another
/// admin account.
async fn assert_may_delete<C: deadpool_postgres::GenericClient>(
    client: &C,
    target_id: i32,
    actor: &AdminActor,
) -> Result<(), PlayerReadError> {
    let row = client
        .query_opt("SELECT is_admin FROM users WHERE id = $1", &[&target_id])
        .await?;
    let Some(row) = row else {
        return Err(PlayerReadError::controlled(
            HTTP_NOT_FOUND,
            ERR_USER_NOT_FOUND,
            CODE_NOT_FOUND,
        ));
    };
    let target_is_admin = truthy_flag(Some(i32_cell(&row, "is_admin")));
    let editing_other = actor.actor_user_id != i64::from(target_id);
    if target_is_admin && editing_other && !actor.actor_is_super_admin {
        return Err(PlayerReadError::controlled(
            HTTP_FORBIDDEN,
            ERR_ADMIN_DELETE_SUPER_ONLY,
            CODE_FORBIDDEN,
        ));
    }
    Ok(())
}

/// Phase 1: everything that can still answer 400/403/404/409 before the
/// hardware wipe makes the account unrecoverable.
pub async fn run_admin_delete_resolve(
    pool: &Pool,
    req: &AdminUserDeleteRequest,
) -> Result<Value, PlayerReadError> {
    let email = parse_admin_user_email(&req.email)?;
    let conn = pool.get().await?;
    let target = resolve_target(&conn, &email).await?;
    assert_may_delete(&conn, target.id, &req.actor).await?;
    Ok(json!({ "userId": target.id }))
}

/// Child-to-parent deletes for the FKs that have no `ON DELETE CASCADE`.
/// Order is load-bearing: `users` goes last.
const CASCADE_SQL: &[&str] = &[
    "DELETE FROM support_ticket_replies WHERE admin_user_id = $1",
    "DELETE FROM support_tickets WHERE user_id = $1",
    "DELETE FROM p2p_market_trade_history WHERE buyer_id = $1 OR seller_id = $1",
];

const PARTNER_CLEANUP_SQL: &[&str] = &[
    "UPDATE partner_youtube_submissions SET reviewed_by = NULL WHERE reviewed_by = $1",
    "UPDATE partner_youtube_creator_profiles SET updated_by = NULL WHERE updated_by = $1",
    "UPDATE partner_youtube_manual_allowlist SET added_by = NULL WHERE added_by = $1",
    "DELETE FROM partner_youtube_manual_allowlist WHERE user_id = $1",
];

const CHILD_ROWS_SQL: &[&str] = &[
    "DELETE FROM referrals WHERE user_id = $1",
    "DELETE FROM player_news_submissions WHERE user_id = $1",
    "DELETE FROM admin_upgrade_purchases WHERE user_id = $1",
    "DELETE FROM season_purchases WHERE user_id = $1",
    "DELETE FROM user_rig_rooms WHERE user_id = $1",
    "DELETE FROM unopened_boxes WHERE user_id = $1",
    "DELETE FROM coin_balances WHERE user_id = $1",
    "DELETE FROM coin_withdrawals WHERE user_id = $1",
    "DELETE FROM withdrawal_requests WHERE user_id = $1",
    "DELETE FROM user_history_ips WHERE user_id = $1",
    "DELETE FROM player_listings WHERE user_id = $1",
    "DELETE FROM daily_actions WHERE user_id = $1",
    "DELETE FROM promo_code_redemptions WHERE user_id = $1",
    "DELETE FROM player_claimed_boxes WHERE user_id = $1",
    "DELETE FROM game_states WHERE user_id = $1",
];

const DELETE_USER_SQL: &str = "DELETE FROM users WHERE id = $1";

/// Node wraps the partner cleanup in `try/catch` and only rethrows when the
/// failure is not "table missing".
async fn run_partner_cleanup(tx: &Transaction<'_>, uid: i32) -> Result<(), PlayerReadError> {
    for sql in PARTNER_CLEANUP_SQL {
        if let Err(e) = tx.execute(*sql, &[&uid]).await {
            if e.code().map(|c| c.code()) == Some(PG_UNDEFINED_TABLE) {
                return Ok(());
            }
            return Err(PlayerReadError::internal(e.to_string()));
        }
    }
    Ok(())
}

/// Phase 2: the cascade itself. The caller must have run the hardware wipe.
pub async fn run_admin_delete_user(
    pool: &Pool,
    http: &Client,
    cfg: &WorkerConfig,
    req: &AdminUserDeleteRequest,
) -> Result<Value, PlayerReadError> {
    let email = parse_admin_user_email(&req.email)?;
    let mut conn = pool.get().await?;
    let target = resolve_target(&conn, &email).await?;
    assert_may_delete(&conn, target.id, &req.actor).await?;
    let uid = target.id;

    // Sessions live in genesis-auth's own store, so they go before the TX that
    // removes the user row (Node calls it mid-transaction for the same reason).
    auth_session_delete_by_user(http, cfg, i64::from(uid)).await?;

    let tx = conn.transaction().await?;
    for sql in CASCADE_SQL {
        tx.execute(*sql, &[&uid]).await?;
    }
    run_partner_cleanup(&tx, uid).await?;
    for sql in CHILD_ROWS_SQL {
        tx.execute(*sql, &[&uid]).await?;
    }
    if let Some(ref username) = target.username {
        tx.execute("DELETE FROM wheel_players WHERE username = $1", &[username])
            .await?;
    }
    if let Some(ref wallet) = target.wallet {
        tx.execute("DELETE FROM nft_items WHERE owner_address = $1", &[wallet])
            .await?;
    }
    tx.execute(DELETE_USER_SQL, &[&uid]).await?;
    tx.commit().await?;

    // Node logs and moves on: the account is already gone.
    if let Err(e) = auth_revoke_refresh(http, cfg, i64::from(uid)).await {
        warn!(user_id = uid, err = %e.error, "revoke refresh after admin delete");
    }

    Ok(Value::Object(serde_json::Map::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_row_is_deleted_last() {
        assert_eq!(DELETE_USER_SQL, "DELETE FROM users WHERE id = $1");
        assert!(!CHILD_ROWS_SQL
            .iter()
            .any(|s| s.contains("DELETE FROM users ")));
        assert!(!CASCADE_SQL.iter().any(|s| s.contains("DELETE FROM users ")));
    }

    #[test]
    fn cascade_covers_the_node_table_list() {
        for table in [
            "support_ticket_replies",
            "support_tickets",
            "p2p_market_trade_history",
        ] {
            assert!(
                CASCADE_SQL.iter().any(|s| s.contains(table)),
                "missing {table}"
            );
        }
        for table in [
            "referrals",
            "player_news_submissions",
            "admin_upgrade_purchases",
            "season_purchases",
            "user_rig_rooms",
            "unopened_boxes",
            "coin_balances",
            "coin_withdrawals",
            "withdrawal_requests",
            "user_history_ips",
            "player_listings",
            "daily_actions",
            "promo_code_redemptions",
            "player_claimed_boxes",
            "game_states",
        ] {
            assert!(
                CHILD_ROWS_SQL.iter().any(|s| s.contains(table)),
                "missing {table}"
            );
        }
    }

    #[test]
    fn every_cascade_statement_is_user_scoped() {
        for sql in CASCADE_SQL
            .iter()
            .chain(CHILD_ROWS_SQL)
            .chain(PARTNER_CLEANUP_SQL)
        {
            assert!(sql.contains("$1"), "unscoped statement: {sql}");
        }
    }

    #[test]
    fn game_states_is_deleted_after_its_children() {
        let gs = CHILD_ROWS_SQL
            .iter()
            .position(|s| s.contains("game_states"))
            .expect("game_states delete");
        let boxes = CHILD_ROWS_SQL
            .iter()
            .position(|s| s.contains("unopened_boxes"))
            .expect("unopened_boxes delete");
        assert!(boxes < gs);
    }
}
