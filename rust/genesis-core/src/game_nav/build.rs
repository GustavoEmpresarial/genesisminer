use super::catalog::{
    CATALOG, DEFAULT_ALLOWED_PAGES, EXTRA_ALWAYS_PAGES, MANAGER_ONLY_KEYS, SECTION_ORDER,
};
use super::types::{GameNavBuildInput, GameNavBuildOutput, GameNavItemOut};

/// Resolve allowlist de páginas (espelha `resolveAllowedPages` no client).
pub fn resolve_allowed_pages(is_managing: bool) -> Vec<String> {
    let mut pages: Vec<String> = DEFAULT_ALLOWED_PAGES
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    for extra in EXTRA_ALWAYS_PAGES {
        if !pages.iter().any(|p| p == *extra) {
            pages.push((*extra).to_string());
        }
    }
    if is_managing {
        return pages
            .into_iter()
            .filter(|p| MANAGER_ONLY_KEYS.contains(&p.as_str()))
            .collect();
    }
    pages
}

fn item_allowed(key: &str, input: &GameNavBuildInput, allowed_pages: &[String]) -> bool {
    let has = |page: &str| allowed_pages.iter().any(|p| p == page);
    let is_managing = input.is_managing_account || input.manager_mode;
    let is_operator_admin_only = input.is_admin && !input.is_super_admin;

    match key {
        "servers" | "inventory" | "hardware_store" | "upgrade" | "black_market" | "lucky_store"
        | "wallet" | "ranking" | "transparency" | "mini_blog" | "quests" | "support"
        | "offerwall" | "arcade" => has(key),
        "dashboard" => false,
        "profile" => !is_managing,
        "management" => input.account_manager_enabled,
        "merge" => input.merge_enabled && has("merge"),
        "calculator" => !is_operator_admin_only,
        "partners" | "partner_games" => true,
        "roleta" => has("roleta") && input.show_roleta_in_nav,
        _ => false,
    }
}

/// Constrói itens filtrados (allowed + modo gerência).
pub fn build_game_nav_items(input: &GameNavBuildInput) -> GameNavBuildOutput {
    let is_managing = input.is_managing_account || input.manager_mode;
    let allowed_pages = resolve_allowed_pages(is_managing);

    let mut items = Vec::new();
    for entry in CATALOG {
        if !item_allowed(entry.key, input, &allowed_pages) {
            continue;
        }
        if is_managing && !MANAGER_ONLY_KEYS.contains(&entry.key) {
            continue;
        }
        items.push(GameNavItemOut {
            key: entry.key.to_string(),
            section: entry.section.as_str().to_string(),
            accent: entry.accent.as_str().to_string(),
        });
    }

    GameNavBuildOutput {
        ok: true,
        section_order: SECTION_ORDER
            .iter()
            .map(|s| s.as_str().to_string())
            .collect(),
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_input() -> GameNavBuildInput {
        GameNavBuildInput {
            is_managing_account: false,
            manager_mode: false,
            is_admin: false,
            is_super_admin: false,
            merge_enabled: true,
            account_manager_enabled: false,
            show_roleta_in_nav: true,
        }
    }

    #[test]
    fn player_sees_hub_ops_economy_keys() {
        let out = build_game_nav_items(&base_input());
        assert!(out.ok);
        let keys: Vec<_> = out.items.iter().map(|i| i.key.as_str()).collect();
        assert!(keys.contains(&"transparency"));
        assert!(keys.contains(&"servers"));
        assert!(keys.contains(&"wallet"));
        assert!(keys.contains(&"roleta"));
        assert!(!keys.contains(&"dashboard"));
        assert!(keys.contains(&"partner_games"));
        assert!(!keys.contains(&"management")); // flag off
    }

    #[test]
    fn management_requires_flag() {
        let mut input = base_input();
        input.account_manager_enabled = true;
        let out = build_game_nav_items(&input);
        assert!(out.items.iter().any(|i| i.key == "management"));
    }

    #[test]
    fn manager_mode_shrinks_nav() {
        let mut input = base_input();
        input.is_managing_account = true;
        input.account_manager_enabled = true;
        let out = build_game_nav_items(&input);
        let keys: Vec<_> = out.items.iter().map(|i| i.key.as_str()).collect();
        assert!(keys.contains(&"servers"));
        assert!(!keys.contains(&"wallet"));
        assert!(!keys.contains(&"transparency"));
        assert!(!keys.contains(&"profile"));
    }

    #[test]
    fn roleta_hidden_when_flag_off() {
        let mut input = base_input();
        input.show_roleta_in_nav = false;
        let out = build_game_nav_items(&input);
        assert!(!out.items.iter().any(|i| i.key == "roleta"));
    }

    #[test]
    fn operator_admin_hides_calculator() {
        let mut input = base_input();
        input.is_admin = true;
        input.is_super_admin = false;
        let out = build_game_nav_items(&input);
        assert!(!out.items.iter().any(|i| i.key == "calculator"));
    }

    #[test]
    fn section_order_is_hub_ops_economy() {
        let out = build_game_nav_items(&base_input());
        assert_eq!(
            out.section_order,
            vec![
                "hub".to_string(),
                "operacao".to_string(),
                "economia".to_string()
            ]
        );
    }
}
