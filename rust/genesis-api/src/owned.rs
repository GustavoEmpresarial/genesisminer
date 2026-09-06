//! Reverse-proxy policy: Express is **admin** plus player leftovers that still
//! have no Rust twin. Socket.IO (`/socket.io*`) is owned by genesis-api
//! (`socketioxide`); game HTTP is Rust. Everything else is owned by genesis-api
//! (handler, static, SPA, or 501).

use http::Method;

const ADMIN_API_PREFIX: &str = "/api/admin";
const ADMIN_UPGRADES_PREFIX: &str = "/api/admin-upgrades";
const SOCKET_IO_PREFIX: &str = "/socket.io";

/// Player game-state (not admin). `:email` = `me`.
pub const GAME_STATE_ME_PATH: &str = "/api/game-state/me";

/// Owned by genesis-api (socketioxide) — never reverse-proxy to Express.
fn is_socket_io(path: &str) -> bool {
    path == SOCKET_IO_PREFIX || path.starts_with("/socket.io/")
}

fn is_admin_prefix(path: &str) -> bool {
    path == ADMIN_API_PREFIX
        || path.starts_with("/api/admin/")
        || path == ADMIN_UPGRADES_PREFIX
        || path.starts_with("/api/admin-upgrades/")
}

/// Player routes that still 501 in genesis-api (no twin yet). Proxy to Express.
///
/// Admin tabs outside the `/api/admin` prefix are all Rust now:
/// `crate::admin_tabs` (upgrades, economy/exchange/monetization settings,
/// upload-image), `crate::admin_catalog` (access-levels, loot-boxes, news +
/// fee + expire-days, mining-coins, season-passes, rig-rooms),
/// `crate::admin_wallet_tabs` (web3-settings, wallet-labels) and
/// `crate::admin_users` (users CRUD + game-state by email).
fn is_unported_player_leftover(_method: &Method, _path: &str) -> bool {
    false
}

/// `true` → reverse-proxy to Express. Admin + unported player leftovers.
/// Socket.IO is **not** proxied (owned by genesis-api).
pub fn should_proxy_express(method: &Method, path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    if is_socket_io(path) {
        return false;
    }
    if is_admin_prefix(path) {
        return true;
    }
    is_unported_player_leftover(method, path)
}

/// Owned by genesis-api (not Express). Inverse of [`should_proxy_express`].
pub fn is_owned_route(method: &Method, path: &str) -> bool {
    !should_proxy_express(method, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_only_admin_leftovers() {
        assert!(should_proxy_express(&Method::GET, "/api/admin/users"));
        assert!(should_proxy_express(&Method::POST, "/api/admin/users"));
        assert!(should_proxy_express(&Method::GET, "/api/admin"));
        // Socket.IO owned by genesis-api — never proxy
        assert!(!should_proxy_express(&Method::GET, "/socket.io/"));
        assert!(!should_proxy_express(&Method::GET, "/socket.io/?EIO=4"));
        assert!(is_owned_route(&Method::GET, "/socket.io/"));
        assert!(!should_proxy_express(&Method::POST, "/api/register"));
    }

    #[test]
    fn shop_checkout_not_proxy() {
        assert!(!should_proxy_express(&Method::POST, "/api/shop/checkout"));
        assert!(is_owned_route(&Method::POST, "/api/shop/checkout"));
    }

    #[test]
    fn admin_users_is_proxy() {
        assert!(should_proxy_express(&Method::GET, "/api/admin/users"));
        assert!(!is_owned_route(&Method::GET, "/api/admin/users"));
    }

    #[test]
    fn img_owned() {
        assert!(is_owned_route(&Method::GET, "/img/x"));
        assert!(is_owned_route(&Method::GET, "/img/foo.png"));
        assert!(!should_proxy_express(&Method::GET, "/img/x"));
    }

    #[test]
    fn game_state_owned_for_player_and_admin() {
        assert!(is_owned_route(&Method::GET, GAME_STATE_ME_PATH));
        assert!(!should_proxy_express(&Method::GET, GAME_STATE_ME_PATH));
        assert!(is_owned_route(&Method::GET, "/api/game-state/foo@bar"));
        assert!(!should_proxy_express(
            &Method::GET,
            "/api/game-state/foo@bar"
        ));
    }

    #[test]
    fn admin_upgrades_prefix_still_proxies() {
        assert!(should_proxy_express(&Method::GET, "/api/admin-upgrades"));
        assert!(should_proxy_express(&Method::POST, "/api/admin-upgrades/x"));
    }

    #[test]
    fn upload_image_owned() {
        assert!(!should_proxy_express(&Method::POST, "/api/upload-image"));
        assert!(is_owned_route(&Method::POST, "/api/upload-image"));
        // The multipart admin twins stay on Express (`multer` + `sharp`).
        assert!(should_proxy_express(
            &Method::POST,
            "/api/admin/upload-image"
        ));
        assert!(should_proxy_express(&Method::POST, "/api/admin/upload-ad"));
    }

    #[test]
    fn ported_admin_tab_writes_owned() {
        for path in [
            "/api/upgrades",
            "/api/economy-settings",
            "/api/exchange-settings",
            "/api/monetization-settings",
        ] {
            assert!(!should_proxy_express(&Method::POST, path), "{path}");
            assert!(is_owned_route(&Method::POST, path), "{path}");
        }
    }

    #[test]
    fn ported_users_tab_routes_owned() {
        for (method, path) in [
            (Method::GET, "/api/users"),
            (Method::PUT, "/api/users/block"),
            (Method::PUT, "/api/user"),
            (Method::DELETE, "/api/user/a@b.c"),
            (Method::GET, "/api/game-state/a@b.c"),
        ] {
            assert!(!should_proxy_express(&method, path), "{method} {path}");
            assert!(is_owned_route(&method, path), "{method} {path}");
        }
    }

    #[test]
    fn admin_users_prefix_still_proxies() {
        // Only the leftovers moved; `/api/admin/users/*` stays on Express.
        assert!(should_proxy_express(
            &Method::GET,
            "/api/admin/users/7/wallet-history"
        ));
        assert!(should_proxy_express(
            &Method::POST,
            "/api/admin/impersonate"
        ));
        assert!(should_proxy_express(
            &Method::POST,
            "/api/admin/users/7/save-game-override"
        ));
        assert!(should_proxy_express(
            &Method::PUT,
            "/api/admin/users/7/rooms"
        ));
    }

    #[test]
    fn player_reads_of_shared_paths_owned() {
        assert!(!should_proxy_express(&Method::GET, "/api/economy-settings"));
        assert!(!should_proxy_express(&Method::GET, "/api/web3-settings"));
        assert!(!should_proxy_express(&Method::GET, "/api/upgrades"));
        assert!(!should_proxy_express(&Method::GET, "/api/rig-rooms"));
        assert!(!should_proxy_express(&Method::GET, "/api/news"));
        assert!(!should_proxy_express(&Method::GET, "/api/guide"));
        assert!(!should_proxy_express(&Method::GET, "/api/roadmap"));
        assert!(!should_proxy_express(&Method::GET, "/api/transparency"));
        assert!(!should_proxy_express(&Method::GET, "/api/merge/config"));
        assert!(!should_proxy_express(&Method::GET, "/"));
        assert!(!should_proxy_express(&Method::GET, "/health/live"));
        assert!(!should_proxy_express(&Method::POST, "/api/login"));
    }

    #[test]
    fn ported_catalog_tab_writes_owned() {
        for path in [
            "/api/access-levels",
            "/api/loot-boxes",
            "/api/news",
            "/api/news-fee",
            "/api/news-expire-days",
            "/api/mining-coins",
            "/api/season-passes",
            "/api/rig-rooms",
        ] {
            assert!(!should_proxy_express(&Method::POST, path), "{path}");
            assert!(is_owned_route(&Method::POST, path), "{path}");
        }
        assert!(is_owned_route(&Method::DELETE, "/api/news/abc"));
        assert!(!should_proxy_express(&Method::DELETE, "/api/news/abc"));
        // The player GETs of the same paths were already owned.
        assert!(!should_proxy_express(&Method::GET, "/api/news-fee"));
        assert!(!should_proxy_express(&Method::GET, "/api/season-passes"));
    }

    #[test]
    fn ported_wallet_tab_routes_owned() {
        for (method, path) in [
            (Method::POST, "/api/web3-settings"),
            (Method::GET, "/api/wallet-labels"),
            (Method::POST, "/api/wallet-labels"),
        ] {
            assert!(!should_proxy_express(&method, path), "{method} {path}");
            assert!(is_owned_route(&method, path), "{method} {path}");
        }
    }

    #[test]
    fn login_still_owned() {
        assert!(is_owned_route(&Method::POST, "/api/login"));
        assert!(is_owned_route(&Method::GET, "/api/session"));
        assert!(is_owned_route(
            &Method::GET,
            "/api/support/attachments/download"
        ));
    }

    #[test]
    fn signup_reset_verify_owned_not_proxy() {
        assert!(is_owned_route(&Method::POST, "/api/register"));
        assert!(!should_proxy_express(&Method::POST, "/api/register"));
        assert!(is_owned_route(&Method::POST, "/api/request-password-reset"));
        assert!(is_owned_route(&Method::POST, "/api/reset-password-secure"));
        assert!(is_owned_route(
            &Method::POST,
            "/api/request-email-verification"
        ));
        assert!(is_owned_route(&Method::POST, "/api/verify-email"));
    }

    #[test]
    fn closed_player_writes_owned() {
        assert!(is_owned_route(&Method::POST, "/api/chat/audio"));
        assert!(is_owned_route(&Method::POST, "/api/support/tickets"));
        assert!(is_owned_route(
            &Method::POST,
            "/api/support/tickets/abc/messages"
        ));
        assert!(is_owned_route(&Method::POST, "/api/quests/claim"));
        assert!(is_owned_route(
            &Method::POST,
            "/api/wallet/exchange/liquidate"
        ));
        assert!(is_owned_route(&Method::POST, "/api/deposit/verify"));
        assert!(is_owned_route(&Method::GET, "/zeradsptc.php"));
        assert!(is_owned_route(&Method::POST, "/zeradsptc.php"));
        assert!(is_owned_route(&Method::GET, "/api/zerads/me/token"));
        assert!(is_owned_route(&Method::GET, "/api/zerads/me/stats"));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/wallet/exchange/liquidate"
        ));
    }

    #[test]
    fn unported_player_leftovers_proxy_owned_stay_owned() {
        assert!(!should_proxy_express(&Method::POST, "/api/register"));
        assert!(is_owned_route(&Method::POST, "/api/register"));
        // Ported: dashboard + partners player + bulk-batteries + partner-games
        assert!(!should_proxy_express(&Method::GET, "/api/dashboard/state"));
        assert!(is_owned_route(&Method::GET, "/api/dashboard/state"));
        assert!(!should_proxy_express(&Method::GET, "/api/partners/state"));
        assert!(!should_proxy_express(&Method::GET, "/api/partners/videos"));
        assert!(!should_proxy_express(
            &Method::GET,
            "/api/partners/my-submissions"
        ));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/partners/videos/submit"
        ));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/partners/youtube/apply"
        ));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/partners/youtube/avatar-upload"
        ));
        assert!(!should_proxy_express(
            &Method::PUT,
            "/api/partners/youtube/my-profile"
        ));
        assert!(is_owned_route(&Method::GET, "/api/partners/state"));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/server-room/bulk-batteries"
        ));
        assert!(is_owned_route(
            &Method::POST,
            "/api/server-room/bulk-batteries"
        ));
        assert!(!should_proxy_express(
            &Method::GET,
            "/api/partner-games/config"
        ));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/partner-games/visit"
        ));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/partner-games/heartbeat"
        ));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/partner-games/stop"
        ));
        assert!(is_owned_route(&Method::GET, "/api/partner-games/config"));
        assert!(!should_proxy_express(
            &Method::PATCH,
            "/api/profile/identity"
        ));
        assert!(is_owned_route(&Method::PATCH, "/api/profile/identity"));
        assert!(!should_proxy_express(&Method::GET, "/api/profile/state"));
        assert!(is_owned_route(&Method::GET, "/api/profile/state"));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/profile/password/change"
        ));
        assert!(is_owned_route(
            &Method::POST,
            "/api/profile/password/change"
        ));
        assert!(!should_proxy_express(
            &Method::GET,
            "/api/profile/security-events"
        ));
        assert!(is_owned_route(&Method::GET, "/api/profile/security-events"));
        assert!(!should_proxy_express(&Method::GET, "/api/profile/wallet"));
        assert!(is_owned_route(&Method::GET, "/api/profile/wallet"));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/profile/wallet/connect/challenge"
        ));
        assert!(is_owned_route(
            &Method::POST,
            "/api/profile/wallet/connect/challenge"
        ));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/profile/wallet/connect/verify"
        ));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/profile/wallet/remove"
        ));
        assert!(!should_proxy_express(
            &Method::DELETE,
            "/api/profile/wallet"
        ));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/profile/referral/bind"
        ));
        assert!(!should_proxy_express(
            &Method::GET,
            "/api/profile/referral/state"
        ));
        assert!(is_owned_route(&Method::GET, "/api/profile/referral/state"));
        assert!(!should_proxy_express(
            &Method::GET,
            "/api/profile/referral/overview"
        ));
        assert!(!should_proxy_express(&Method::GET, "/api/news"));
        assert!(is_owned_route(&Method::GET, "/api/news"));
        // Partners player owned; admin still Express under /api/admin
        assert!(!should_proxy_express(&Method::GET, "/api/partners"));
        assert!(!should_proxy_express(&Method::GET, "/api/partners/me"));
        assert!(!should_proxy_express(&Method::GET, "/api/account-manager"));
        assert!(!should_proxy_express(
            &Method::GET,
            "/api/account-manager/me"
        ));
        assert!(is_owned_route(&Method::GET, "/api/account-manager/me"));
        assert!(is_owned_route(&Method::POST, "/api/account-manager/hire"));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/wheel/redeem-code"
        ));
        assert!(!should_proxy_express(&Method::POST, "/api/wheel/roll"));
        assert!(!should_proxy_express(&Method::POST, "/api/roleta/claim"));
        assert!(!should_proxy_express(
            &Method::POST,
            "/api/lucky-boxes/promocodes/redeem"
        ));
    }
}
