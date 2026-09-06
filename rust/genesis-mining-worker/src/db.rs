//! Postgres connection pool (`deadpool-postgres`).

use deadpool_postgres::{Config, Pool, Runtime};
use tokio_postgres::NoTls;

use crate::config::WorkerConfig;

pub fn create_pool(cfg: &WorkerConfig) -> anyhow::Result<Pool> {
    let mut pg = Config::new();
    pg.url = Some(cfg.database_url.clone());
    let pool = pg.create_pool(Some(Runtime::Tokio1), NoTls)?;
    Ok(pool)
}
