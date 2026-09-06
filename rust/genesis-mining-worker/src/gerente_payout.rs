//! Liquidação de semanas UTC fechadas da share do gerente.
//!
//! Espelho de `server/modules/gerente/services/payout.ts` (`payClosedManagerWeeks`).
//! Cada accrual unpaid é a sua própria TX (progresso parcial se o job abortar).

use deadpool_postgres::Pool;
use genesis_core::utc_week::utc_week_start_ms;
use serde::Serialize;
use tracing::warn;

use crate::config::{WorkerConfig, MINED_COIN_AMOUNT_DECIMALS};

pub const GERENTE_PAYOUT_PATH: &str = "/v1/gerente/payout";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GerentePayoutResult {
    pub ok: bool,
    pub paid: u32,
    pub skipped: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn round_mined_coin_amount(raw: f64) -> f64 {
    if !raw.is_finite() || raw == 0.0 {
        return 0.0;
    }
    let scale = 10f64.powi(MINED_COIN_AMOUNT_DECIMALS);
    (raw * scale).round() / scale
}

/// Liquida accruals com `week_start < openWeekStart` e `paid_at IS NULL`.
pub async fn pay_closed_manager_weeks(
    pool: &Pool,
    cfg: &WorkerConfig,
    now_ms: i64,
) -> GerentePayoutResult {
    if !cfg.account_manager_enabled {
        return GerentePayoutResult {
            ok: true,
            paid: 0,
            skipped: 0,
            error: None,
        };
    }

    let open_week_start = utc_week_start_ms(now_ms);
    let client = match pool.get().await {
        Ok(c) => c,
        Err(e) => {
            return GerentePayoutResult {
                ok: false,
                paid: 0,
                skipped: 0,
                error: Some(format!("gerente payout pool: {e}")),
            };
        }
    };

    let list_res = match client
        .query(
            r#"SELECT a.contract_id, a.coin_id, a.week_start, a.manager_share_amount, c.manager_user_id
                 FROM account_manager_mining_accrual a
                 JOIN account_manager_contracts c ON c.id = a.contract_id
                WHERE a.paid_at IS NULL
                  AND a.week_start < $1
                  AND a.manager_share_amount > 0
                ORDER BY a.week_start, a.contract_id, a.coin_id"#,
            &[&open_week_start],
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            return GerentePayoutResult {
                ok: false,
                paid: 0,
                skipped: 0,
                error: Some(format!("gerente payout list: {e}")),
            };
        }
    };

    let mut paid: u32 = 0;
    let mut skipped: u32 = 0;

    for row in list_res {
        let contract_id: i32 = row.get("contract_id");
        let coin_id: String = row.get("coin_id");
        let week_start: i64 = row.get("week_start");
        let manager_user_id: i32 = row.get("manager_user_id");
        if coin_id.is_empty() {
            skipped = skipped.saturating_add(1);
            continue;
        }

        match pay_one_row(
            pool,
            contract_id,
            &coin_id,
            week_start,
            manager_user_id,
            now_ms,
        )
        .await
        {
            Ok(PayOneOutcome::Paid) => paid = paid.saturating_add(1),
            Ok(PayOneOutcome::Skipped) => skipped = skipped.saturating_add(1),
            Err(e) => {
                warn!(
                    contract_id,
                    coin_id = %coin_id,
                    week_start,
                    err = %e,
                    "gerente payout row failed"
                );
                skipped = skipped.saturating_add(1);
            }
        }
    }

    GerentePayoutResult {
        ok: true,
        paid,
        skipped,
        error: None,
    }
}

enum PayOneOutcome {
    Paid,
    Skipped,
}

async fn pay_one_row(
    pool: &Pool,
    contract_id: i32,
    coin_id: &str,
    week_start: i64,
    manager_user_id: i32,
    now_ms: i64,
) -> anyhow::Result<PayOneOutcome> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;

    let locked_rows = tx
        .query(
            r#"SELECT contract_id, coin_id, week_start, manager_share_amount, paid_at
                 FROM account_manager_mining_accrual
                WHERE contract_id = $1
                  AND coin_id = $2
                  AND week_start = $3
                FOR UPDATE"#,
            &[&contract_id, &coin_id, &week_start],
        )
        .await?;
    let Some(locked) = locked_rows.first() else {
        tx.rollback().await?;
        return Ok(PayOneOutcome::Skipped);
    };
    let paid_at: Option<i64> = locked.get("paid_at");
    if paid_at.is_some() {
        tx.rollback().await?;
        return Ok(PayOneOutcome::Skipped);
    }

    let share_raw: f64 = locked.get("manager_share_amount");
    let amount = round_mined_coin_amount(share_raw);
    let idempotency_key = format!("am_payout:{contract_id}:{coin_id}:{week_start}");

    let ledger_rows = tx
        .query(
            r#"INSERT INTO account_manager_payout_ledger
                 (contract_id, coin_id, week_start, amount, paid_at, idempotency_key)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (idempotency_key) DO NOTHING
               RETURNING id"#,
            &[
                &contract_id,
                &coin_id,
                &week_start,
                &amount,
                &now_ms,
                &idempotency_key,
            ],
        )
        .await?;

    if ledger_rows.is_empty() {
        // Já pago no ledger — sincroniza paid_at sem creditar de novo.
        tx.execute(
            r#"UPDATE account_manager_mining_accrual
                  SET paid_at = $1
                WHERE contract_id = $2
                  AND coin_id = $3
                  AND week_start = $4
                  AND paid_at IS NULL"#,
            &[&now_ms, &contract_id, &coin_id, &week_start],
        )
        .await?;
        tx.commit().await?;
        return Ok(PayOneOutcome::Skipped);
    }

    if amount > 0.0 {
        tx.execute(
            r#"INSERT INTO coin_balances (user_id, coin_id, amount)
               VALUES ($1, $2, $3)
               ON CONFLICT (user_id, coin_id) DO UPDATE
                 SET amount = coin_balances.amount + EXCLUDED.amount"#,
            &[&manager_user_id, &coin_id, &amount],
        )
        .await?;
    }

    tx.execute(
        r#"UPDATE account_manager_mining_accrual
              SET paid_at = $1
            WHERE contract_id = $2
              AND coin_id = $3
              AND week_start = $4
              AND paid_at IS NULL"#,
        &[&now_ms, &contract_id, &coin_id, &week_start],
    )
    .await?;

    tx.commit().await?;
    Ok(PayOneOutcome::Paid)
}
