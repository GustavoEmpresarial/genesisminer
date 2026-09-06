//! Gerente (account-manager) player twins + payout cron.
//!
//! Espelho de `server/modules/gerente/services/manager.ts` + controller HTTP.

mod auth_session;
mod manager;
mod payout_loop;

pub use manager::{
    run_accept, run_apply, run_decline, run_enter, run_fire, run_hire, run_leave, run_me,
    run_resign, GerenteActorRequest, GerenteContractIdRequest, GerenteEnterRequest,
    GerenteMeRequest, GerenteResignRequest, GerenteTargetRequest,
};
pub use payout_loop::run_gerente_payout_loop;

pub const GERENTE_ME_PATH: &str = "/v1/gerente/me";
pub const GERENTE_HIRE_PATH: &str = "/v1/gerente/hire";
pub const GERENTE_APPLY_PATH: &str = "/v1/gerente/apply";
pub const GERENTE_ACCEPT_PATH: &str = "/v1/gerente/accept";
pub const GERENTE_DECLINE_PATH: &str = "/v1/gerente/decline";
pub const GERENTE_FIRE_PATH: &str = "/v1/gerente/fire";
pub const GERENTE_RESIGN_PATH: &str = "/v1/gerente/resign";
pub const GERENTE_ENTER_PATH: &str = "/v1/gerente/enter";
pub const GERENTE_LEAVE_PATH: &str = "/v1/gerente/leave";
