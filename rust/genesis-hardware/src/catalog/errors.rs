//! Domain errors for `/v1/catalog/*`.

pub use crate::market::errors::{HTTP_BAD_REQUEST, HTTP_CONFLICT};

use genesis_core::catalog::CatalogWriteError;

pub const CODE_CATALOG_VERSION_CONFLICT: &str = "CATALOG_VERSION_CONFLICT";
pub const CODE_CATALOG_REVISION_REQUIRED: &str = "CATALOG_REVISION_REQUIRED";
pub const CODE_CATALOG_PAYLOAD_INVALID: &str = "CATALOG_PAYLOAD_INVALID";

pub const ERR_CATALOG_REVISION_REQUIRED: &str = "expectedCatalogRevision obrigatório.";
pub const ERR_CATALOG_REVISION_INVALID: &str = "expectedCatalogRevision inválido.";
pub const ERR_CATALOG_VERSION_CONFLICT: &str =
    "Catálogo foi alterado desde a última leitura. Recarregue e tente novamente.";
pub const ERR_CATALOG_PAYLOAD_INVALID: &str = "Payload inválido.";

#[derive(Debug)]
pub enum CatalogError {
    Domain {
        status: u16,
        error: String,
        code: Option<String>,
        catalog_revision: Option<i64>,
        expected_catalog_revision: Option<i64>,
        force_reload: Option<bool>,
        previous_id: Option<String>,
        attempted_id: Option<String>,
    },
    Transport(anyhow::Error),
}

impl CatalogError {
    #[allow(dead_code)]
    pub fn domain(status: u16, error: impl Into<String>) -> Self {
        Self::Domain {
            status,
            error: error.into(),
            code: None,
            catalog_revision: None,
            expected_catalog_revision: None,
            force_reload: None,
            previous_id: None,
            attempted_id: None,
        }
    }

    pub fn domain_code(status: u16, error: impl Into<String>, code: impl Into<String>) -> Self {
        Self::Domain {
            status,
            error: error.into(),
            code: Some(code.into()),
            catalog_revision: None,
            expected_catalog_revision: None,
            force_reload: None,
            previous_id: None,
            attempted_id: None,
        }
    }

    #[allow(dead_code)]
    pub fn bad(error: impl Into<String>) -> Self {
        Self::domain(HTTP_BAD_REQUEST, error)
    }

    pub fn bad_code(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self::domain_code(HTTP_BAD_REQUEST, error, code)
    }

    #[allow(dead_code)]
    pub fn conflict_code(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self::domain_code(HTTP_CONFLICT, error, code)
    }

    pub fn version_conflict(current: i64, expected: i64) -> Self {
        Self::Domain {
            status: HTTP_CONFLICT,
            error: ERR_CATALOG_VERSION_CONFLICT.to_string(),
            code: Some(CODE_CATALOG_VERSION_CONFLICT.to_string()),
            catalog_revision: Some(current),
            expected_catalog_revision: Some(expected),
            force_reload: Some(true),
            previous_id: None,
            attempted_id: None,
        }
    }

    pub fn transport(err: impl Into<anyhow::Error>) -> Self {
        Self::Transport(err.into())
    }
}

impl From<CatalogWriteError> for CatalogError {
    fn from(e: CatalogWriteError) -> Self {
        Self::Domain {
            status: e.status_code,
            error: e.error,
            code: Some(e.code),
            catalog_revision: None,
            expected_catalog_revision: None,
            force_reload: None,
            previous_id: e.previous_id,
            attempted_id: e.attempted_id,
        }
    }
}

impl From<deadpool_postgres::PoolError> for CatalogError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::Transport(e.into())
    }
}

impl From<tokio_postgres::Error> for CatalogError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Transport(e.into())
    }
}
