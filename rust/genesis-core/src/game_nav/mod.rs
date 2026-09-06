//! Menu do jogo (sidebar) — catálogo, allowlist e filtros.
//! Sem i18n/ícones (ficam no client). Sem números mágicos de tempo.

mod build;
mod catalog;
mod types;

pub use build::{build_game_nav_items, resolve_allowed_pages};
pub use catalog::{DEFAULT_ALLOWED_PAGES, EXTRA_ALWAYS_PAGES, MANAGER_ONLY_KEYS, SECTION_ORDER};
pub use types::{
    GameNavAccent, GameNavBuildInput, GameNavBuildOutput, GameNavItemOut, GameNavSection,
};
