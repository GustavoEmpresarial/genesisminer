use super::types::{GameNavAccent, GameNavSection};

/// Fallback allowlist (alinhado a `DEFAULT_ALLOWED_PAGES` no client).
pub const DEFAULT_ALLOWED_PAGES: &[&str] = &[
    "servers",
    "inventory",
    "merge",
    "arcade",
    "ranking",
    "hardware_store",
    "black_market",
    "lucky_store",
    "wallet",
    "withdrawal_history",
    "deposit_history",
    "upgrade",
    "profile",
    "transparency",
    "support",
    "partners",
    "partner_games",
    "mini_blog",
    "quests",
    "offerwall",
];

/// Extras sempre acrescentados a jogadores autenticados (legado).
pub const EXTRA_ALWAYS_PAGES: &[&str] = &["partners", "mini_blog", "quests", "offerwall", "roleta"];

/// Em modo gerência só estas keys passam no filtro final.
pub const MANAGER_ONLY_KEYS: &[&str] = &[
    "servers",
    "dashboard",
    "management",
    "quests",
    "merge",
    "offerwall",
    "inventory",
    "lucky_store",
    "calculator",
];

pub const SECTION_ORDER: &[GameNavSection] = &[
    GameNavSection::Hub,
    GameNavSection::Operacao,
    GameNavSection::Economia,
];

#[derive(Debug, Clone, Copy)]
pub(crate) struct CatalogEntry {
    pub key: &'static str,
    pub section: GameNavSection,
    pub accent: GameNavAccent,
}

/// Ordem do catálogo = ordem do array TS em `buildGameNavItems` (antes do filter).
pub(crate) const CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        key: "servers",
        section: GameNavSection::Operacao,
        accent: GameNavAccent::Amber,
    },
    CatalogEntry {
        key: "dashboard",
        section: GameNavSection::Operacao,
        accent: GameNavAccent::Sky,
    },
    CatalogEntry {
        key: "profile",
        section: GameNavSection::Operacao,
        accent: GameNavAccent::Sky,
    },
    CatalogEntry {
        key: "management",
        section: GameNavSection::Operacao,
        accent: GameNavAccent::Sky,
    },
    CatalogEntry {
        key: "inventory",
        section: GameNavSection::Operacao,
        accent: GameNavAccent::Yellow,
    },
    CatalogEntry {
        key: "merge",
        section: GameNavSection::Operacao,
        accent: GameNavAccent::Amber,
    },
    CatalogEntry {
        key: "hardware_store",
        section: GameNavSection::Operacao,
        accent: GameNavAccent::Amber,
    },
    CatalogEntry {
        key: "upgrade",
        section: GameNavSection::Operacao,
        accent: GameNavAccent::Yellow,
    },
    CatalogEntry {
        key: "black_market",
        section: GameNavSection::Economia,
        accent: GameNavAccent::Red,
    },
    CatalogEntry {
        key: "lucky_store",
        section: GameNavSection::Economia,
        accent: GameNavAccent::Orange,
    },
    CatalogEntry {
        key: "wallet",
        section: GameNavSection::Economia,
        accent: GameNavAccent::Orange,
    },
    CatalogEntry {
        key: "ranking",
        section: GameNavSection::Economia,
        accent: GameNavAccent::Yellow,
    },
    CatalogEntry {
        key: "calculator",
        section: GameNavSection::Economia,
        accent: GameNavAccent::Yellow,
    },
    CatalogEntry {
        key: "transparency",
        section: GameNavSection::Hub,
        accent: GameNavAccent::Emerald,
    },
    CatalogEntry {
        key: "mini_blog",
        section: GameNavSection::Hub,
        accent: GameNavAccent::Orange,
    },
    CatalogEntry {
        key: "quests",
        section: GameNavSection::Hub,
        accent: GameNavAccent::Amber,
    },
    CatalogEntry {
        key: "support",
        section: GameNavSection::Hub,
        accent: GameNavAccent::Sky,
    },
    CatalogEntry {
        key: "partners",
        section: GameNavSection::Hub,
        accent: GameNavAccent::Violet,
    },
    CatalogEntry {
        key: "partner_games",
        section: GameNavSection::Hub,
        accent: GameNavAccent::Amber,
    },
    CatalogEntry {
        key: "offerwall",
        section: GameNavSection::Hub,
        accent: GameNavAccent::Emerald,
    },
    CatalogEntry {
        key: "arcade",
        section: GameNavSection::Hub,
        accent: GameNavAccent::Amber,
    },
    CatalogEntry {
        key: "roleta",
        section: GameNavSection::Hub,
        accent: GameNavAccent::Rose,
    },
];
