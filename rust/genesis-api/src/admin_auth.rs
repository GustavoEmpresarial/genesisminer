//! Admin authorization twin — Node `isAdmin` middleware.
//!
//! Ports `server/shared/security/admin-route-auth.ts` (route → required tab)
//! plus the gate half of `server/modules/auth/services/admin-guard.ts`
//! (`loadAdminGateContext` → mining-worker `POST /v1/users/admin-gate`).
//!
//! The route table is a sequence of checks, not a map: most rules depend on
//! `starts_with` or on the method, and order matters (specific rules first,
//! `/api/admin/*` falls through to `Super` — deny by default).

use std::collections::HashSet;

use axum::http::{HeaderMap, Method};
use axum::response::Response;
use serde_json::{json, Value};
use tracing::warn;

use crate::config::AppState;
use crate::session::{json_status, require_player};
use crate::workers::{post_mining, worker_infra_status, worker_unavailable_body};

const ADMIN_GATE_PATH: &str = "/v1/users/admin-gate";

/// Node `HTTP_FORBIDDEN` in admin-guard.ts.
const HTTP_FORBIDDEN: u16 = 403;

/// Node `res.status(403).json({ error: 'Access denied' })`.
const ERR_ACCESS_DENIED: &str = "Access denied";
/// Node `res.status(403).json({ error: 'Permissão insuficiente...' })`.
const ERR_INSUFFICIENT_PERMISSION: &str = "Permissão insuficiente para esta operação.";

/// Admin panel tabs referenced by the route table (`users.admin_permissions`).
const TAB_USERS: &str = "users";
const TAB_REPORTS: &str = "reports";
const TAB_GAMES: &str = "games";
const TAB_PARTNERS: &str = "partners";
const TAB_SUPPORT: &str = "support";
const TAB_SECURITY: &str = "security";
const TAB_LOOTBOXES: &str = "lootboxes";
const TAB_BACKUP: &str = "backup";
const TAB_TRANSPARENCY: &str = "transparency";
const TAB_DASHBOARD: &str = "dashboard";
const TAB_METRICS: &str = "metrics";
const TAB_SETTINGS: &str = "settings";
const TAB_SETTINGS_LABELS: &str = "settings:labels";
const TAB_SETTINGS_PAGES: &str = "settings:pages";
const TAB_SETTINGS_NEWS: &str = "settings:news";
const TAB_SETTINGS_MONETIZATION: &str = "settings:monetization";
const TAB_SETTINGS_RIGROOMS: &str = "settings:rigrooms";
const TAB_SHOPS: &str = "shops";
const TAB_SHOPS_HARDWARE: &str = "shops:hardware";

const TABS_UPLOAD_AD: &[&str] = &[TAB_PARTNERS, TAB_SETTINGS_NEWS];
const TABS_PROMO_CODES: &[&str] = &[TAB_SETTINGS_MONETIZATION, TAB_LOOTBOXES];
const TABS_ADMIN_METRICS: &[&str] = &[TAB_METRICS, TAB_DASHBOARD];

/// Node `AdminRouteRequirement`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdminRouteRequirement {
    Super,
    Tab(&'static str),
    AnyOf(&'static [&'static str]),
}

/// What Node exposes to admin handlers as `req.userId` / `req.isSuperAdmin` /
/// `req.adminPermissions`. The settings + catalog writes ported so far only
/// need the gate decision; handlers that branch on the actor (users CRUD,
/// wallet-labels) read these fields once ported.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AdminCtx {
    pub user_id: i64,
    pub is_super_admin: bool,
    pub tabs: HashSet<String>,
}

/// Node `permissionTabSetFromDbJson` — accepts a string array or a flag object,
/// and never throws (invalid JSON yields an empty set).
pub fn permission_tab_set_from_db_json(raw: &Value) -> HashSet<String> {
    let mut set = HashSet::new();
    let parsed_from_string;
    let value = match raw {
        Value::Null => return set,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return set;
            }
            match serde_json::from_str::<Value>(t) {
                Ok(v) => {
                    parsed_from_string = v;
                    &parsed_from_string
                }
                Err(_) => return set,
            }
        }
        other => other,
    };
    match value {
        Value::Array(items) => {
            for item in items {
                if let Some(s) = item.as_str() {
                    let t = s.trim();
                    if !t.is_empty() {
                        set.insert(t.to_string());
                    }
                }
            }
        }
        Value::Object(map) => {
            for (k, v) in map {
                let enabled = matches!(v, Value::Bool(true)) || v.as_f64() == Some(1.0);
                if enabled {
                    set.insert(k.clone());
                }
            }
        }
        _ => {}
    }
    set
}

/// Node `adminTabAllows` — exact tab, parent tab, or any `parent:*` child.
pub fn admin_tab_allows(tabs: &HashSet<String>, required: &str) -> bool {
    if tabs.contains(required) {
        return true;
    }
    if let Some(colon) = required.find(':') {
        if colon > 0 && tabs.contains(&required[..colon]) {
            return true;
        }
    }
    if !required.contains(':') {
        let child_prefix = format!("{required}:");
        return tabs.iter().any(|t| t.starts_with(&child_prefix));
    }
    false
}

/// Node `allowsAdminRouteAccess` — super passes everything, `Super` blocks
/// everyone else (no granular equivalent).
pub fn allows_admin_route_access(
    is_super_admin: bool,
    tabs: &HashSet<String>,
    rule: &AdminRouteRequirement,
) -> bool {
    if is_super_admin {
        return true;
    }
    match rule {
        AdminRouteRequirement::Super => false,
        AdminRouteRequirement::Tab(tab) => admin_tab_allows(tabs, tab),
        AdminRouteRequirement::AnyOf(list) => list.iter().any(|t| admin_tab_allows(tabs, t)),
    }
}

/// Node `/^\/api\/admin\/users\/[^/]+\/<suffix>$/`.
fn admin_user_sub_route(path: &str, suffix: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/admin/users/") else {
        return false;
    };
    let Some(id) = rest.strip_suffix(suffix) else {
        return false;
    };
    !id.is_empty() && !id.contains('/')
}

/// Node `resolveAdminRouteRequirement`.
pub fn resolve_admin_route_requirement(method: &Method, raw_path: &str) -> AdminRouteRequirement {
    use AdminRouteRequirement::{AnyOf, Super, Tab};

    let p = raw_path.split('?').next().unwrap_or(raw_path);
    let is_get = method == Method::GET;
    let is_post = method == Method::POST;
    let is_put = method == Method::PUT;
    let is_delete = method == Method::DELETE;

    if p == "/api/admin/update-permissions" {
        return Super;
    }
    if p == "/api/admin/impersonate" && is_post {
        return Tab(TAB_USERS);
    }
    if p == "/api/admin/bulk-delete"
        || p == "/api/admin/recall-all-players-items"
        || p == "/api/admin/restore"
        || p == "/api/admin/promo-codes/bulk-delete"
    {
        return Super;
    }

    if p.starts_with("/api/admin/wheel/") || p == "/api/admin/reset-daily-boost" {
        return Tab(TAB_GAMES);
    }
    if p == "/api/mining-coins" && is_post {
        return Super;
    }
    if p.starts_with("/api/mining/coins") && !is_get {
        return Super;
    }

    if p.starts_with("/api/admin/partner-youtube")
        || p.starts_with("/api/admin/partner-videos")
        || p.starts_with("/api/admin/streamer-room-users")
    {
        return Tab(TAB_PARTNERS);
    }
    if p == "/api/admin/upload-ad" {
        return AnyOf(TABS_UPLOAD_AD);
    }

    if p.starts_with("/api/admin/support-tickets") || p.starts_with("/api/admin/support/") {
        return Tab(TAB_SUPPORT);
    }
    if p == "/api/admin/device-fingerprints" || p.starts_with("/api/admin/security/") {
        return Tab(TAB_SECURITY);
    }

    if p.starts_with("/api/admin/loot-boxes")
        || p.starts_with("/api/admin/user-boxes")
        || p == "/api/admin/delete-user-box"
        || p.starts_with("/api/admin/loot-box-redemptions/")
    {
        return Tab(TAB_LOOTBOXES);
    }
    if p == "/api/loot-boxes" && is_post {
        return Tab(TAB_LOOTBOXES);
    }

    if p.starts_with("/api/admin/backups")
        || p == "/api/admin/backup"
        || p.starts_with("/api/admin/backup-settings")
        || p == "/api/admin/recall-scan"
    {
        return Tab(TAB_BACKUP);
    }

    if p.starts_with("/api/admin/transparency") {
        return Tab(TAB_TRANSPARENCY);
    }

    if p == "/api/admin/display-labels" {
        return Tab(TAB_SETTINGS_LABELS);
    }
    if p.starts_with("/api/admin/ui-accent") {
        return Tab(TAB_SETTINGS_PAGES);
    }

    if p.starts_with("/api/player-news/") {
        return Tab(TAB_SETTINGS_NEWS);
    }
    if p.starts_with("/api/admin/checkin-premium-policy")
        || p.starts_with("/api/admin/checkin-reward-policy")
    {
        return Tab(TAB_SETTINGS_MONETIZATION);
    }
    if p.starts_with("/api/admin/announcements") || p.starts_with("/api/admin/in-app-announcements")
    {
        return Tab(TAB_SETTINGS_NEWS);
    }
    if p == "/api/news" || p.starts_with("/api/news/") {
        return Tab(TAB_SETTINGS_NEWS);
    }
    if p == "/api/news-fee" || p == "/api/news-expire-days" {
        return Tab(TAB_SETTINGS_NEWS);
    }

    if p.starts_with("/api/season-passes") || p == "/api/season-pass/grant" {
        return Tab(TAB_SETTINGS_MONETIZATION);
    }
    if p.starts_with("/api/admin/monetization-settings") {
        return Tab(TAB_SETTINGS_MONETIZATION);
    }
    if p == "/api/admin/quests" {
        return Tab(TAB_SETTINGS_MONETIZATION);
    }
    if p == "/api/monetization-settings" && is_post {
        return Tab(TAB_SETTINGS_MONETIZATION);
    }
    if p.starts_with("/api/admin/promo-codes") {
        return AnyOf(TABS_PROMO_CODES);
    }

    if p == "/api/access-levels" && is_post {
        return Tab(TAB_SETTINGS);
    }
    if p == "/api/rig-rooms" && is_post {
        return Tab(TAB_SETTINGS_RIGROOMS);
    }

    if p == "/api/web3-settings" && is_post {
        return Super;
    }
    if p == "/api/wallet-labels" && is_get {
        return Tab(TAB_REPORTS);
    }
    if p == "/api/wallet-labels" && is_post {
        return Super;
    }
    if p == "/api/nfts/receive" && is_post {
        return Super;
    }

    if p == "/api/admin-upgrades" || p.starts_with("/api/admin-upgrades/") {
        return Tab(TAB_SHOPS_HARDWARE);
    }
    if p == "/api/upgrades" && is_post {
        return Tab(TAB_SHOPS_HARDWARE);
    }

    if p == "/api/admin/market/listings" {
        return Tab(TAB_SHOPS);
    }

    if p == "/api/exchange-settings" && is_post {
        return Super;
    }

    if p == "/api/users" && is_get {
        return Tab(TAB_USERS);
    }
    if p == "/api/user" && is_put {
        return Tab(TAB_USERS);
    }
    if p == "/api/admin/users/map" {
        return Tab(TAB_USERS);
    }
    if p == "/api/users/block" && is_put {
        return Tab(TAB_USERS);
    }
    if p.starts_with("/api/user/") && is_delete {
        return Tab(TAB_USERS);
    }
    if p.starts_with("/api/admin/referral-models")
        || p.starts_with("/api/admin/access-level-referral-assignments")
        || p == "/api/admin/bulk-gift"
        || p.starts_with("/api/admin/user-activity")
    {
        return Tab(TAB_USERS);
    }
    if is_get
        && (admin_user_sub_route(p, "/inventory-audit")
            || admin_user_sub_route(p, "/session-snapshots")
            || admin_user_sub_route(p, "/account-trace"))
    {
        return Tab(TAB_USERS);
    }
    if p == "/api/admin/update-coin-balance"
        || p == "/api/admin/bulk-update-coin-balance"
        || p == "/api/admin/ranking-exclusion"
        || p == "/api/admin/ranking"
        || p == "/api/admin/accounts-dormant-mining"
    {
        return Tab(TAB_USERS);
    }
    if is_post && admin_user_sub_route(p, "/save-game-override") {
        return Tab(TAB_USERS);
    }
    if is_put && admin_user_sub_route(p, "/rooms") {
        return Tab(TAB_USERS);
    }
    if is_get && is_game_state_by_email(p) {
        return Tab(TAB_USERS);
    }
    if is_get && admin_user_sub_route(p, "/wallet-history") {
        return Tab(TAB_USERS);
    }
    if is_get
        && (p == "/api/admin/users/suspicious-emails"
            || p == "/api/admin/users/suspicious-emails/export.csv")
    {
        return Tab(TAB_USERS);
    }
    if is_post && p == "/api/admin/users/suspicious-emails/deactivate-filtered" {
        return Tab(TAB_USERS);
    }

    if p.starts_with("/api/admin/economy-stats")
        || p.starts_with("/api/admin/mining-distribution/")
        || p.starts_with("/api/admin/mining-runtime-summary")
        || p.starts_with("/api/admin/etherscan/")
    {
        return Tab(TAB_REPORTS);
    }
    if p.starts_with("/api/admin/withdrawals") {
        return Super;
    }
    if p == "/api/admin/economy-settings" && is_post {
        return Super;
    }
    if p == "/api/admin/mining-coins/sync-live-prices" && is_post {
        return Super;
    }
    if p == "/api/economy-settings" && is_post {
        return Tab(TAB_REPORTS);
    }

    if p == "/api/admin/dashboard-stats" {
        return Tab(TAB_DASHBOARD);
    }
    if p == "/api/admin/metrics" {
        return AnyOf(TABS_ADMIN_METRICS);
    }

    if p.starts_with("/api/admin/guide") || p.starts_with("/api/admin/roadmap") {
        return Tab(TAB_SETTINGS_PAGES);
    }

    Super
}

/// Node `/^\/api\/game-state\/.+/` minus `/api/game-state/me`.
fn is_game_state_by_email(path: &str) -> bool {
    path.starts_with("/api/game-state/")
        && path.len() > "/api/game-state/".len()
        && path != crate::owned::GAME_STATE_ME_PATH
}

fn forbidden(error: &str) -> Response {
    json_status(HTTP_FORBIDDEN, json!({ "error": error }))
}

/// Session → admin gate, **without** the route/tab check. Twin of the handlers
/// that assert `users.is_admin` inline instead of mounting `isAdmin`
/// (`POST /api/upload-image` in `image-asset.controller.ts`): any admin passes,
/// no tab is required.
pub async fn require_is_admin(state: &AppState, headers: &HeaderMap) -> Result<AdminCtx, Response> {
    load_admin_ctx(state, headers).await
}

/// Node `isAdmin` middleware: session → admin flag → tab permission.
pub async fn require_admin(
    state: &AppState,
    headers: &HeaderMap,
    method: &Method,
    path: &str,
) -> Result<AdminCtx, Response> {
    let ctx = load_admin_ctx(state, headers).await?;
    let rule = resolve_admin_route_requirement(method, path);
    if !allows_admin_route_access(ctx.is_super_admin, &ctx.tabs, &rule) {
        return Err(forbidden(ERR_INSUFFICIENT_PERMISSION));
    }
    Ok(ctx)
}

/// Session + `POST /v1/users/admin-gate` — the half of Node `isAdmin` that
/// only decides "is this actor an admin at all".
async fn load_admin_ctx(state: &AppState, headers: &HeaderMap) -> Result<AdminCtx, Response> {
    let user_id = require_player(state, headers).await?;
    let gate = match post_mining(
        &state.cfg,
        &state.http,
        ADMIN_GATE_PATH,
        &json!({ "userId": user_id }),
    )
    .await
    {
        Ok(r) if r.body["ok"] == true => r.body,
        Ok(r) => {
            return Err(json_status(
                if r.status == 0 { 502 } else { r.status },
                json!({ "error": ERR_ACCESS_DENIED }),
            ));
        }
        Err(e) => {
            warn!(err = %e.message(), "admin gate");
            return Err(json_status(
                worker_infra_status(&e),
                worker_unavailable_body(&e),
            ));
        }
    };

    if gate["isAdmin"] != true {
        return Err(forbidden(ERR_ACCESS_DENIED));
    }
    let is_super_admin = gate["isSuperAdmin"] == true;
    let tabs =
        permission_tab_set_from_db_json(gate.get("adminPermissions").unwrap_or(&Value::Null));
    Ok(AdminCtx {
        user_id,
        is_super_admin,
        tabs,
    })
}

#[cfg(test)]
mod tests {
    use super::AdminRouteRequirement::{AnyOf, Super, Tab};
    use super::*;

    fn tabs(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn tab_set_from_array_object_and_garbage() {
        assert_eq!(
            permission_tab_set_from_db_json(&json!(["users", " reports ", "", 7])),
            tabs(&["users", "reports"])
        );
        assert_eq!(
            permission_tab_set_from_db_json(
                &json!({ "users": true, "reports": 1, "shops": false, "x": 0 })
            ),
            tabs(&["users", "reports"])
        );
        assert!(permission_tab_set_from_db_json(&Value::Null).is_empty());
        assert!(permission_tab_set_from_db_json(&json!("not-json")).is_empty());
        assert!(permission_tab_set_from_db_json(&json!("   ")).is_empty());
        // Legacy rows store the JSON as a string.
        assert_eq!(
            permission_tab_set_from_db_json(&json!(r#"["users"]"#)),
            tabs(&["users"])
        );
    }

    #[test]
    fn tab_allows_parent_and_children() {
        assert!(admin_tab_allows(&tabs(&["shops"]), "shops:hardware"));
        assert!(admin_tab_allows(&tabs(&["shops:hardware"]), "shops"));
        assert!(admin_tab_allows(
            &tabs(&["shops:hardware"]),
            "shops:hardware"
        ));
        assert!(!admin_tab_allows(
            &tabs(&["shops:hardware"]),
            "shops:market"
        ));
        assert!(!admin_tab_allows(&tabs(&["users"]), "reports"));
        assert!(admin_tab_allows(&tabs(&["settings:news"]), "settings"));
        assert!(!admin_tab_allows(&HashSet::new(), "users"));
    }

    #[test]
    fn super_admin_passes_every_rule() {
        let empty = HashSet::new();
        assert!(allows_admin_route_access(true, &empty, &Super));
        assert!(allows_admin_route_access(true, &empty, &Tab(TAB_USERS)));
        assert!(!allows_admin_route_access(false, &empty, &Super));
        assert!(!allows_admin_route_access(false, &tabs(&["users"]), &Super));
        assert!(allows_admin_route_access(
            false,
            &tabs(&["users"]),
            &Tab(TAB_USERS)
        ));
        assert!(allows_admin_route_access(
            false,
            &tabs(&["dashboard"]),
            &AnyOf(TABS_ADMIN_METRICS)
        ));
    }

    #[test]
    fn leftover_tab_rules_match_node() {
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/upgrades"),
            Tab(TAB_SHOPS_HARDWARE)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/economy-settings"),
            Tab(TAB_REPORTS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/exchange-settings"),
            Super
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/monetization-settings"),
            Tab(TAB_SETTINGS_MONETIZATION)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/web3-settings"),
            Super
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/access-levels"),
            Tab(TAB_SETTINGS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/rig-rooms"),
            Tab(TAB_SETTINGS_RIGROOMS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/loot-boxes"),
            Tab(TAB_LOOTBOXES)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/mining-coins"),
            Super
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/news"),
            Tab(TAB_SETTINGS_NEWS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::DELETE, "/api/news/abc"),
            Tab(TAB_SETTINGS_NEWS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/news-fee"),
            Tab(TAB_SETTINGS_NEWS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/news-expire-days"),
            Tab(TAB_SETTINGS_NEWS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/season-passes"),
            Tab(TAB_SETTINGS_MONETIZATION)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, "/api/users"),
            Tab(TAB_USERS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::PUT, "/api/user"),
            Tab(TAB_USERS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::PUT, "/api/users/block"),
            Tab(TAB_USERS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::DELETE, "/api/user/a@b.c"),
            Tab(TAB_USERS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, "/api/wallet-labels"),
            Tab(TAB_REPORTS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/wallet-labels"),
            Super
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, "/api/game-state/foo@bar.com"),
            Tab(TAB_USERS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, "/api/admin-upgrades"),
            Tab(TAB_SHOPS_HARDWARE)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/admin-upgrades/x"),
            Tab(TAB_SHOPS_HARDWARE)
        );
    }

    #[test]
    fn query_string_is_ignored() {
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, "/api/users?page=2"),
            Tab(TAB_USERS)
        );
    }

    #[test]
    fn game_state_me_is_not_an_admin_route() {
        assert!(!is_game_state_by_email(crate::owned::GAME_STATE_ME_PATH));
        assert!(!is_game_state_by_email("/api/game-state/"));
        assert!(is_game_state_by_email("/api/game-state/a@b.c"));
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, crate::owned::GAME_STATE_ME_PATH),
            Super
        );
    }

    #[test]
    fn admin_prefix_rules_and_default_deny() {
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/admin/update-permissions"),
            Super
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/admin/impersonate"),
            Tab(TAB_USERS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, "/api/admin/impersonate"),
            Super
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, "/api/admin/metrics"),
            AnyOf(TABS_ADMIN_METRICS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/admin/upload-ad"),
            AnyOf(TABS_UPLOAD_AD)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, "/api/admin/promo-codes"),
            AnyOf(TABS_PROMO_CODES)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, "/api/admin/support-tickets"),
            Tab(TAB_SUPPORT)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, "/api/admin/anything-new"),
            Super
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, "/api/admin/users/7/inventory-audit"),
            Tab(TAB_USERS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/admin/users/7/inventory-audit"),
            Super
        );
        assert_eq!(
            resolve_admin_route_requirement(
                &Method::GET,
                "/api/admin/users/7/deep/inventory-audit"
            ),
            Super
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/admin/users/7/save-game-override"),
            Tab(TAB_USERS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::PUT, "/api/admin/users/7/rooms"),
            Tab(TAB_USERS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::POST, "/api/mining/coins/x"),
            Super
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, "/api/admin/economy-stats/top"),
            Tab(TAB_REPORTS)
        );
        assert_eq!(
            resolve_admin_route_requirement(&Method::GET, "/api/admin/withdrawals"),
            Super
        );
    }

    #[test]
    fn ported_leftovers_need_the_right_tab() {
        let reports = tabs(&["reports"]);
        let hardware = tabs(&["shops:hardware"]);
        let monetization = tabs(&["settings:monetization"]);
        for (method, path, allowed, denied) in [
            (Method::POST, "/api/economy-settings", &reports, &hardware),
            (Method::POST, "/api/upgrades", &hardware, &reports),
            (
                Method::POST,
                "/api/monetization-settings",
                &monetization,
                &reports,
            ),
        ] {
            let rule = resolve_admin_route_requirement(&method, path);
            assert!(
                allows_admin_route_access(false, allowed, &rule),
                "{path} should allow"
            );
            assert!(
                !allows_admin_route_access(false, denied, &rule),
                "{path} should deny"
            );
        }
        // Exchange settings is super-only: no tab grants it.
        let rule = resolve_admin_route_requirement(&Method::POST, "/api/exchange-settings");
        assert!(!allows_admin_route_access(false, &reports, &rule));
        assert!(allows_admin_route_access(true, &HashSet::new(), &rule));
    }
}
