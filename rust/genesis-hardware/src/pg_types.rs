//! Postgres bind helpers — Prisma `user_id` / `stock.qty` columns are INT4.

/// `stock.user_id` / `player_asic_leases.user_id` / rack & battery tables are INT4.
/// tokio-postgres rejects i64→INT4 (same as `genesis-mining-worker` progress).
pub fn pg_user_id(uid: i64) -> anyhow::Result<i32> {
    i32::try_from(uid).map_err(|_| anyhow::anyhow!("user_id out of int4 range: {uid}"))
}

/// `stock.qty` is INT4 — never truncate with `as i32`.
pub fn pg_qty(qty: i64) -> anyhow::Result<i32> {
    i32::try_from(qty).map_err(|_| anyhow::anyhow!("qty out of int4 range: {qty}"))
}

/// PostgreSQL LIMIT/OFFSET bind type is INT8; never bind i32.
pub fn pg_limit(n: i32) -> i64 {
    i64::from(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_user_id_accepts_i32_max() {
        assert_eq!(pg_user_id(i64::from(i32::MAX)).unwrap(), i32::MAX);
    }

    #[test]
    fn pg_user_id_rejects_above_i32() {
        assert!(pg_user_id(i64::from(i32::MAX).saturating_add(1)).is_err());
    }

    #[test]
    fn pg_qty_accepts_i32_max() {
        assert_eq!(pg_qty(i64::from(i32::MAX)).unwrap(), i32::MAX);
    }

    #[test]
    fn pg_qty_rejects_above_i32() {
        assert!(pg_qty(i64::from(i32::MAX).saturating_add(1)).is_err());
    }

    #[test]
    fn pg_qty_rejects_below_i32() {
        assert!(pg_qty(i64::from(i32::MIN).saturating_sub(1)).is_err());
    }

    #[test]
    fn pg_limit_zero() {
        assert_eq!(pg_limit(0), 0);
    }

    #[test]
    fn pg_limit_i32_max() {
        assert_eq!(pg_limit(i32::MAX), i64::from(i32::MAX));
    }
}
