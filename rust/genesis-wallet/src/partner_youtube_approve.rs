//! Partner YouTube video submission approve — pending → approved.
//!
//! Mirrors Node `updatePartnerYoutubeApprove`. Admin auth stays in Node;
//! this worker only runs the UPDATE (status gate).

use deadpool_postgres::Pool;
use serde::Serialize;

use crate::config::current_unix_ms;
use crate::errors::WalletError;
use crate::pg_types::pg_user_id;

/// UUID length from `crypto.randomUUID()` (Node submit).
const SUBMISSION_ID_MAX: usize = 36;
const STATUS_PENDING: &str = "pending";
const STATUS_APPROVED: &str = "approved";

const ERR_INVALID_ID: &str = "ID inválido.";

pub const PARTNER_YOUTUBE_APPROVE_PATH: &str = "/v1/partners/youtube/submissions/approve";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerYoutubeApproveOk {
    pub ok: bool,
    pub updated: i64,
}

fn parse_submission_id(raw: &str) -> Result<String, WalletError> {
    let id = raw.trim();
    if id.is_empty() || id.len() > SUBMISSION_ID_MAX {
        return Err(WalletError::bad(ERR_INVALID_ID));
    }
    Ok(id.to_string())
}

pub async fn run_partner_youtube_approve(
    pool: &Pool,
    submission_id: &str,
    admin_user_id: i64,
    reviewed_at_ms: Option<i64>,
) -> Result<PartnerYoutubeApproveOk, WalletError> {
    let id = parse_submission_id(submission_id)?;
    let admin_id = pg_user_id(admin_user_id).map_err(WalletError::transport)?;
    let reviewed_at = reviewed_at_ms.unwrap_or_else(current_unix_ms);

    let client = pool.get().await.map_err(WalletError::transport)?;
    let n = client
        .execute(
            "UPDATE partner_youtube_submissions
                SET status = $1,
                    reviewed_at = $2,
                    reviewed_by = $3,
                    reject_reason = NULL
              WHERE id = $4 AND status = $5",
            &[
                &STATUS_APPROVED,
                &reviewed_at,
                &admin_id,
                &id,
                &STATUS_PENDING,
            ],
        )
        .await
        .map_err(WalletError::transport)?;

    Ok(PartnerYoutubeApproveOk {
        ok: true,
        updated: i64::try_from(n).unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rejects_empty_and_overlong() {
        assert!(parse_submission_id("").is_err());
        assert!(parse_submission_id("   ").is_err());
        assert!(parse_submission_id(&"x".repeat(SUBMISSION_ID_MAX + 1)).is_err());
        assert_eq!(
            parse_submission_id("550e8400-e29b-41d4-a716-446655440000").unwrap(),
            "550e8400-e29b-41d4-a716-446655440000"
        );
    }
}
