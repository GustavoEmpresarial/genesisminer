//! Postgres bind helpers — Prisma `user_id` / `sessions.user_id` are INT4.

pub fn pg_user_id(uid: i64) -> anyhow::Result<i32> {
    i32::try_from(uid).map_err(|_| anyhow::anyhow!("user_id out of int4 range: {uid}"))
}
