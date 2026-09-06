use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameNavSection {
    Hub,
    Operacao,
    Economia,
}

impl GameNavSection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hub => "hub",
            Self::Operacao => "operacao",
            Self::Economia => "economia",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameNavAccent {
    Amber,
    Yellow,
    Red,
    Orange,
    Rose,
    Emerald,
    Sky,
    Violet,
}

impl GameNavAccent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Amber => "amber",
            Self::Yellow => "yellow",
            Self::Red => "red",
            Self::Orange => "orange",
            Self::Rose => "rose",
            Self::Emerald => "emerald",
            Self::Sky => "sky",
            Self::Violet => "violet",
        }
    }
}

/// Input JSON (camelCase) — flags de sessão do jogador.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameNavBuildInput {
    #[serde(default)]
    pub is_managing_account: bool,
    #[serde(default)]
    pub manager_mode: bool,
    #[serde(default)]
    pub is_admin: bool,
    #[serde(default)]
    pub is_super_admin: bool,
    /// Default true se omitido (legado: `mergeEnabled !== false`).
    #[serde(default = "default_true")]
    pub merge_enabled: bool,
    /// Default false (legado: `accountManagerEnabled === true`).
    #[serde(default)]
    pub account_manager_enabled: bool,
    /// Default true (roleta visível na nav).
    #[serde(default = "default_true")]
    pub show_roleta_in_nav: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameNavItemOut {
    pub key: String,
    pub section: String,
    pub accent: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameNavBuildOutput {
    pub ok: bool,
    pub section_order: Vec<String>,
    pub items: Vec<GameNavItemOut>,
}
