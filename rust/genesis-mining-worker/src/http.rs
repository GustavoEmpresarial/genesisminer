//! Axum HTTP surface for Node → Rust progress + ranking + chat + support + announcements.

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Multipart, Query, State};
use axum::http::{Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use deadpool_postgres::Pool;
use genesis_core::ranking::{
    AdminMiningRankingPayload, MyGlobalMiningRank, PublicMiningRankingPayload,
};
use serde::Deserialize;
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

use crate::admin_gate::{run_admin_gate, AdminGateRequest, USERS_ADMIN_GATE_PATH};
use crate::admin_users::delete::{
    run_admin_delete_resolve, run_admin_delete_user, AdminUserDeleteRequest,
};
use crate::admin_users::list::run_admin_users_list;
use crate::admin_users::update::{run_admin_update_user, AdminUserUpdateRequest};
use crate::admin_users::{
    run_admin_block_user, AdminUsersBlockRequest, AdminUsersListRequest, ADMIN_USERS_BLOCK_PATH,
    ADMIN_USERS_DELETE_PATH, ADMIN_USERS_DELETE_RESOLVE_PATH, ADMIN_USERS_LIST_PATH,
    ADMIN_USERS_UPDATE_PATH,
};
use crate::announcements::{
    run_announcement_admin_list, run_announcement_create, run_announcement_delete,
    run_announcement_get, run_announcement_mark_read, run_announcement_mini_blog,
    run_announcement_pending, run_announcement_update, AnnouncementAdminListResponse,
    AnnouncementCreateRequest, AnnouncementDeleteRequest, AnnouncementGetRequest,
    AnnouncementListResponse, AnnouncementMarkReadRequest, AnnouncementUpdateRequest,
    AnnouncementUserListRequest, AnnouncementWriteResponse, ANNOUNCEMENTS_ADMIN_LIST_PATH,
    ANNOUNCEMENTS_CREATE_PATH, ANNOUNCEMENTS_DELETE_PATH, ANNOUNCEMENTS_GET_PATH,
    ANNOUNCEMENTS_MARK_READ_PATH, ANNOUNCEMENTS_MINI_BLOG_PATH, ANNOUNCEMENTS_PENDING_PATH,
    ANNOUNCEMENTS_UPDATE_PATH,
};
use crate::calculator::{
    run_calculator_snapshot, warn_if_server_error, CalculatorSnapshotErrorBody,
    CalculatorSnapshotRequest, CALCULATOR_SNAPSHOT_PATH,
};
use crate::calculator_ai::{
    run_calculator_ai_analyze, CalculatorAiAnalyzeRequest, CALCULATOR_AI_ANALYZE_PATH,
};
use crate::chat_presence::{
    run_chat_presence, run_chat_rate_limit, ChatPresenceRequest, ChatPresenceResponse,
    ChatRateLimitRequest, ChatRateLimitResponse, CHAT_PRESENCE_PATH, CHAT_RATE_LIMIT_PATH,
};
use crate::chat_purge::{
    run_purge_expired_chat_messages, ChatPurgeRequest, ChatPurgeResponse, CHAT_PURGE_EXPIRED_PATH,
};
use crate::chat_reads::{
    run_chat_can_access, run_chat_get, run_chat_history, run_chat_mentions_resolve,
    run_chat_mentions_search, run_chat_peers, run_chat_sender, ChatCanAccessRequest,
    ChatCanAccessResponse, ChatGetRequest, ChatGetResponse, ChatHistoryRequest,
    ChatHistoryResponse, ChatMentionsResolveRequest, ChatMentionsResponse,
    ChatMentionsSearchRequest, ChatPeersRequest, ChatPeersResponse, ChatSenderRequest,
    ChatSenderResponse, CHAT_CAN_ACCESS_PATH, CHAT_GET_PATH, CHAT_HISTORY_PATH,
    CHAT_MENTIONS_RESOLVE_PATH, CHAT_MENTIONS_SEARCH_PATH, CHAT_PEERS_PATH, CHAT_SENDER_PATH,
};
use crate::chat_writes::{
    run_chat_delete, run_chat_edit, run_chat_insert, ChatDeleteRequest, ChatDeleteResponse,
    ChatEditRequest, ChatEditResponse, ChatInsertRequest, ChatInsertResponse, CHAT_DELETE_PATH,
    CHAT_EDIT_PATH, CHAT_INSERT_PATH,
};
use crate::config::{WorkerConfig, MINING_WORKER_AUTH_HEADER};
use crate::dashboard::{run_dashboard_state, DashboardStateRequest, DASHBOARD_STATE_PATH};
use crate::gerente::{
    run_accept, run_apply, run_decline, run_enter, run_fire, run_hire, run_leave, run_me,
    run_resign, GerenteActorRequest, GerenteContractIdRequest, GerenteEnterRequest,
    GerenteMeRequest, GerenteResignRequest, GerenteTargetRequest, GERENTE_ACCEPT_PATH,
    GERENTE_APPLY_PATH, GERENTE_DECLINE_PATH, GERENTE_ENTER_PATH, GERENTE_FIRE_PATH,
    GERENTE_HIRE_PATH, GERENTE_LEAVE_PATH, GERENTE_ME_PATH, GERENTE_RESIGN_PATH,
};
use crate::gerente_payout::{pay_closed_manager_weeks, GerentePayoutResult, GERENTE_PAYOUT_PATH};
use crate::kafka::SharedKafka;
use crate::partner_games::{
    run_config as run_partner_games_config, run_heartbeat as run_partner_games_heartbeat,
    run_stop as run_partner_games_stop, run_visit as run_partner_games_visit,
    PartnerGamesUserRequest, PARTNER_GAMES_CONFIG_PATH, PARTNER_GAMES_HEARTBEAT_PATH,
    PARTNER_GAMES_STOP_PATH, PARTNER_GAMES_VISIT_PATH,
};
use crate::partners::{
    run_apply as run_partners_apply, run_my_submissions, run_partners_state,
    run_partners_video_by_id, run_partners_videos, run_profile_update, run_submit_video,
    PartnersApplyRequest, PartnersProfileRequest, PartnersStateRequest, PartnersSubmitRequest,
    PartnersUserRequest, PartnersVideoByIdRequest, PartnersVideosRequest, PARTNERS_APPLY_PATH,
    PARTNERS_MY_SUBMISSIONS_PATH, PARTNERS_PROFILE_PATH, PARTNERS_STATE_PATH, PARTNERS_SUBMIT_PATH,
    PARTNERS_VIDEOS_PATH, PARTNERS_VIDEO_BY_ID_PATH,
};
use crate::quests_admin::{
    run_quests_admin_list, run_quests_admin_save, QuestSaveRequest, QUESTS_ADMIN_LIST_PATH,
    QUESTS_ADMIN_SAVE_PATH,
};
use crate::admin_dashboard::{
    run_dashboard_stats, run_ranking_exclusion, run_site_metrics, run_users_map,
    RankingExclusionRequest, DASHBOARD_METRICS_PATH, DASHBOARD_RANKING_EXCLUSION_PATH,
    DASHBOARD_STATS_PATH, DASHBOARD_USERS_MAP_PATH,
};
use crate::partners_admin::{
    run_admin_allowlist_add, run_admin_allowlist_remove, run_admin_application_approve,
    run_admin_application_reject, run_admin_applications_list, run_admin_creator_get,
    run_admin_creator_put, run_admin_partners_list, run_admin_streamer_room_users,
    run_admin_submission_delete, run_admin_submission_reject, run_admin_submissions_list,
    PartnersAdminAllowlistAddRequest, PartnersAdminCreatorPutRequest, PartnersAdminIdActionRequest,
    PartnersAdminIdRequest, PartnersAdminListRequest, PartnersAdminUserIdRequest,
    PARTNERS_ADMIN_ALLOWLIST_ADD_PATH, PARTNERS_ADMIN_ALLOWLIST_REMOVE_PATH,
    PARTNERS_ADMIN_APPLICATION_APPROVE_PATH, PARTNERS_ADMIN_APPLICATION_REJECT_PATH,
    PARTNERS_ADMIN_APPLICATIONS_LIST_PATH, PARTNERS_ADMIN_CREATOR_GET_PATH,
    PARTNERS_ADMIN_CREATOR_PUT_PATH, PARTNERS_ADMIN_PARTNERS_LIST_PATH,
    PARTNERS_ADMIN_STREAMER_USERS_PATH, PARTNERS_ADMIN_SUBMISSION_DELETE_PATH,
    PARTNERS_ADMIN_SUBMISSION_REJECT_PATH, PARTNERS_ADMIN_SUBMISSIONS_LIST_PATH,
};
use crate::player_reads::checkin::{run_checkin_perform, run_checkin_status, CheckinUserRequest};
use crate::player_reads::guide::run_guide;
use crate::player_reads::header::{
    run_header, run_header_highlight, HeaderHighlightRequest, HeaderRequest,
};
use crate::player_reads::nav::{run_nav, NavRequest};
use crate::player_reads::profile::{run_profile_state, ProfileRequest};
use crate::player_reads::quests::run_quests_state;
use crate::player_reads::roadmap::run_roadmap;
use crate::player_reads::settings::{
    run_display_labels, run_economy_settings, run_exchange_settings, run_monetization_settings,
    run_monetization_settings_admin,
};
use crate::player_reads::transparency::{run_transparency_health, run_transparency_list};
use crate::player_reads::{
    fail_read, now_ms, ok_payload, CHECKIN_PERFORM_PATH, CHECKIN_STATUS_PATH, DISPLAY_LABELS_PATH,
    ECONOMY_SETTINGS_PATH, EXCHANGE_SETTINGS_PATH, GUIDE_PATH, HEADER_HIGHLIGHT_PATH, HEADER_PATH,
    MONETIZATION_SETTINGS_ADMIN_PATH, MONETIZATION_SETTINGS_PATH, NAV_PATH, PROFILE_STATE_PATH, QUESTS_STATE_PATH, ROADMAP_PATH,
    TRANSPARENCY_HEALTH_PATH, TRANSPARENCY_PATH,
};
use crate::profile_writes::{
    fail_write, list_profile_security_events, ok_write, run_change_password, run_patch_identity,
    run_referral_bind, run_referral_overview, run_referral_state, run_wallet_challenge,
    run_wallet_get, run_wallet_remove, run_wallet_verify, ProfileIdentityRequest,
    ProfilePasswordChangeRequest, ProfileReferralBindRequest, ProfileReferralReadRequest,
    ProfileSecurityEventsRequest, ProfileWalletUserRequest, ProfileWalletVerifyRequest,
    OVERVIEW_HISTORY_LIMIT, PROFILE_IDENTITY_PATH, PROFILE_PASSWORD_CHANGE_PATH,
    PROFILE_REFERRAL_BIND_PATH, PROFILE_REFERRAL_OVERVIEW_PATH, PROFILE_REFERRAL_STATE_PATH,
    PROFILE_SECURITY_EVENTS_PATH, PROFILE_WALLET_CHALLENGE_PATH, PROFILE_WALLET_GET_PATH,
    PROFILE_WALLET_REMOVE_PATH, PROFILE_WALLET_VERIFY_PATH, SECURITY_EVENTS_CONTROLLER_LIMIT,
};
use crate::progress::{compute_progress_for_user, ProgressResult};
use crate::ranking::RankingService;
use crate::redis_lock::RedisLockClient;
use crate::settings_writes::{
    run_persist_economy_settings, run_persist_exchange_settings, run_persist_monetization_settings,
    SettingsPersistRequest, ECONOMY_SETTINGS_PERSIST_PATH, EXCHANGE_SETTINGS_PERSIST_PATH,
    MONETIZATION_SETTINGS_PERSIST_PATH,
};
use crate::support::{
    run_support_admin_reply, run_support_reply, run_support_submit, SupportAdminReplyRequest,
    SupportAdminReplyResponse, SupportReplyRequest, SupportReplyResponse, SupportSubmitRequest,
    SupportSubmitResponse, SUPPORT_ADMIN_REPLY_PATH, SUPPORT_REPLY_PATH, SUPPORT_SUBMIT_PATH,
};
use crate::support_reads::{
    run_support_admin_get, run_support_admin_history, run_support_admin_list,
    run_support_admin_status, run_support_admin_ticket_payload, run_support_admin_tickets_payload,
    run_support_admin_user_history_payload,
    run_support_admin_stats, run_support_archive, run_support_attachment_referenced,
    run_support_get, run_support_list_mine, run_support_reopen, run_support_state,
    run_support_ticket_for_player, SupportAdminGetRequest, SupportAdminGetResponse,
    SupportAdminHistoryRequest, SupportAdminHistoryResponse, SupportAdminListRequest,
    SupportAdminListResponse, SupportAdminStatsRequest, SupportAdminStatsResponse,
    SupportAdminStatusRequest, SupportAdminTicketPayloadRequest, SupportAdminTicketsPayloadRequest,
    SupportAdminUserHistoryRequest,
    SupportAttachmentReferencedRequest, SupportAttachmentReferencedResponse, SupportGetRequest,
    SupportGetResponse, SupportListMineRequest, SupportListMineResponse, SupportStateRequest,
    SupportStatusChangeRequest, SupportStatusChangeResponse,
    SupportTicketForPlayerRequest, SupportTicketForPlayerResponse, SUPPORT_ADMIN_GET_PATH,
    SUPPORT_ADMIN_HISTORY_PATH, SUPPORT_ADMIN_LIST_PATH, SUPPORT_ADMIN_STATS_PATH,
    SUPPORT_ADMIN_STATUS_PATH, SUPPORT_ADMIN_TICKETS_PAYLOAD_PATH, SUPPORT_ADMIN_TICKET_PAYLOAD_PATH,
    SUPPORT_ADMIN_USER_HISTORY_PATH,
    SUPPORT_ARCHIVE_PATH, SUPPORT_ATTACHMENT_REFERENCED_PATH, SUPPORT_GET_PATH,
    SUPPORT_LIST_MINE_PATH, SUPPORT_REOPEN_PATH, SUPPORT_STATE_PATH,
    SUPPORT_TICKET_FOR_PLAYER_PATH,
};
use crate::uploads::{
    run_upload_admin_image_data_url, run_upload_chat_audio, run_upload_partner_avatar,
    run_upload_support_attachment, AdminImageDataUrlRequest, UploadWriteResponse,
    UPLOAD_ADMIN_IMAGE_DATA_URL_PATH, UPLOAD_CHAT_AUDIO_PATH, UPLOAD_HTTP_BODY_LIMIT_BYTES,
    UPLOAD_PARTNER_AVATAR_PATH, UPLOAD_SUPPORT_ATTACHMENT_PATH,
};
use crate::users::{
    run_assert_active_user, AssertActiveRequest, AssertActiveResponse, USERS_ASSERT_ACTIVE_PATH,
};

#[derive(Clone)]
pub struct AppState {
    pub pool: Pool,
    pub locks: RedisLockClient,
    pub cfg: WorkerConfig,
    pub ranking: RankingService,
    pub kafka: SharedKafka,
    pub http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressRequest {
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankingMeQuery {
    pub user_id: Option<i64>,
    pub fresh: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankingPublicQuery {
    pub fresh: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GerentePayoutRequest {
    pub server_now_ms: Option<i64>,
}

pub fn router(state: AppState) -> Router {
    let state = Arc::new(state);
    let protected = Router::new()
        .route("/v1/mining/progress", post(post_progress))
        .route(GERENTE_PAYOUT_PATH, post(post_gerente_payout))
        .route(GERENTE_ME_PATH, post(post_gerente_me))
        .route(GERENTE_HIRE_PATH, post(post_gerente_hire))
        .route(GERENTE_APPLY_PATH, post(post_gerente_apply))
        .route(GERENTE_ACCEPT_PATH, post(post_gerente_accept))
        .route(GERENTE_DECLINE_PATH, post(post_gerente_decline))
        .route(GERENTE_FIRE_PATH, post(post_gerente_fire))
        .route(GERENTE_RESIGN_PATH, post(post_gerente_resign))
        .route(GERENTE_ENTER_PATH, post(post_gerente_enter))
        .route(GERENTE_LEAVE_PATH, post(post_gerente_leave))
        .route("/v1/ranking/public", get(get_ranking_public))
        .route("/v1/ranking/me", get(get_ranking_me))
        .route("/v1/ranking/admin", get(get_ranking_admin))
        .route("/v1/ranking/refresh", post(post_ranking_refresh))
        .route(CHAT_PURGE_EXPIRED_PATH, post(post_chat_purge_expired))
        .route(CHAT_INSERT_PATH, post(post_chat_insert))
        .route(CHAT_EDIT_PATH, post(post_chat_edit))
        .route(CHAT_DELETE_PATH, post(post_chat_delete))
        .route(CHAT_HISTORY_PATH, post(post_chat_history))
        .route(CHAT_GET_PATH, post(post_chat_get))
        .route(CHAT_SENDER_PATH, post(post_chat_sender))
        .route(CHAT_PEERS_PATH, post(post_chat_peers))
        .route(CHAT_MENTIONS_SEARCH_PATH, post(post_chat_mentions_search))
        .route(CHAT_MENTIONS_RESOLVE_PATH, post(post_chat_mentions_resolve))
        .route(CHAT_CAN_ACCESS_PATH, post(post_chat_can_access))
        .route(CHAT_RATE_LIMIT_PATH, post(post_chat_rate_limit))
        .route(CHAT_PRESENCE_PATH, post(post_chat_presence))
        .route(USERS_ASSERT_ACTIVE_PATH, post(post_assert_active_user))
        .route(USERS_ADMIN_GATE_PATH, post(post_admin_gate))
        .route(ADMIN_USERS_LIST_PATH, post(post_admin_users_list))
        .route(ADMIN_USERS_BLOCK_PATH, post(post_admin_users_block))
        .route(ADMIN_USERS_UPDATE_PATH, post(post_admin_users_update))
        .route(
            ADMIN_USERS_DELETE_RESOLVE_PATH,
            post(post_admin_users_delete_resolve),
        )
        .route(ADMIN_USERS_DELETE_PATH, post(post_admin_users_delete))
        .route(
            SUPPORT_TICKET_FOR_PLAYER_PATH,
            post(post_support_ticket_for_player),
        )
        .route(
            SUPPORT_ATTACHMENT_REFERENCED_PATH,
            post(post_support_attachment_referenced),
        )
        .route(ANNOUNCEMENTS_GET_PATH, post(post_announcement_get))
        .route(
            UPLOAD_CHAT_AUDIO_PATH,
            post(post_upload_chat_audio).layer(DefaultBodyLimit::max(UPLOAD_HTTP_BODY_LIMIT_BYTES)),
        )
        .route(
            UPLOAD_SUPPORT_ATTACHMENT_PATH,
            post(post_upload_support_attachment)
                .layer(DefaultBodyLimit::max(UPLOAD_HTTP_BODY_LIMIT_BYTES)),
        )
        .route(
            UPLOAD_PARTNER_AVATAR_PATH,
            post(post_upload_partner_avatar)
                .layer(DefaultBodyLimit::max(UPLOAD_HTTP_BODY_LIMIT_BYTES)),
        )
        .route(
            UPLOAD_ADMIN_IMAGE_DATA_URL_PATH,
            post(post_upload_admin_image_data_url)
                .layer(DefaultBodyLimit::max(UPLOAD_HTTP_BODY_LIMIT_BYTES)),
        )
        .route(SUPPORT_SUBMIT_PATH, post(post_support_submit))
        .route(SUPPORT_REPLY_PATH, post(post_support_reply))
        .route(SUPPORT_ADMIN_REPLY_PATH, post(post_support_admin_reply))
        .route(SUPPORT_LIST_MINE_PATH, post(post_support_list_mine))
        .route(SUPPORT_GET_PATH, post(post_support_get))
        .route(SUPPORT_STATE_PATH, post(post_support_state))
        .route(SUPPORT_ARCHIVE_PATH, post(post_support_archive))
        .route(SUPPORT_REOPEN_PATH, post(post_support_reopen))
        .route(SUPPORT_ADMIN_LIST_PATH, post(post_support_admin_list))
        .route(SUPPORT_ADMIN_GET_PATH, post(post_support_admin_get))
        .route(SUPPORT_ADMIN_HISTORY_PATH, post(post_support_admin_history))
        .route(SUPPORT_ADMIN_STATS_PATH, post(post_support_admin_stats))
        .route(SUPPORT_ADMIN_TICKETS_PAYLOAD_PATH, post(post_support_admin_tickets_payload))
        .route(SUPPORT_ADMIN_TICKET_PAYLOAD_PATH, post(post_support_admin_ticket_payload))
        .route(SUPPORT_ADMIN_USER_HISTORY_PATH, post(post_support_admin_user_history))
        .route(SUPPORT_ADMIN_STATUS_PATH, post(post_support_admin_status_toggle))
        .route(ANNOUNCEMENTS_CREATE_PATH, post(post_announcement_create))
        .route(ANNOUNCEMENTS_UPDATE_PATH, post(post_announcement_update))
        .route(ANNOUNCEMENTS_DELETE_PATH, post(post_announcement_delete))
        .route(
            ANNOUNCEMENTS_MARK_READ_PATH,
            post(post_announcement_mark_read),
        )
        .route(ANNOUNCEMENTS_PENDING_PATH, post(post_announcement_pending))
        .route(
            ANNOUNCEMENTS_MINI_BLOG_PATH,
            post(post_announcement_mini_blog),
        )
        .route(
            ANNOUNCEMENTS_ADMIN_LIST_PATH,
            post(post_announcement_admin_list),
        )
        .route(CALCULATOR_SNAPSHOT_PATH, post(post_calculator_snapshot))
        .route(CALCULATOR_AI_ANALYZE_PATH, post(post_calculator_ai_analyze))
        .route(CHECKIN_STATUS_PATH, post(post_checkin_status))
        .route(CHECKIN_PERFORM_PATH, post(post_checkin_perform))
        .route(QUESTS_STATE_PATH, post(post_quests_state))
        .route(QUESTS_ADMIN_LIST_PATH, post(post_quests_admin_list))
        .route(DASHBOARD_STATS_PATH, post(post_dashboard_stats))
        .route(DASHBOARD_METRICS_PATH, post(post_dashboard_metrics))
        .route(DASHBOARD_RANKING_EXCLUSION_PATH, post(post_dashboard_ranking_exclusion))
        .route(DASHBOARD_USERS_MAP_PATH, post(post_dashboard_users_map))
        .route(QUESTS_ADMIN_SAVE_PATH, post(post_quests_admin_save))
        .route(HEADER_PATH, post(post_player_header))
        .route(HEADER_HIGHLIGHT_PATH, post(post_player_header_highlight))
        .route(NAV_PATH, post(post_player_nav))
        .route(ECONOMY_SETTINGS_PATH, post(post_economy_settings))
        .route(EXCHANGE_SETTINGS_PATH, post(post_exchange_settings))
        .route(MONETIZATION_SETTINGS_PATH, post(post_monetization_settings))
        .route(MONETIZATION_SETTINGS_ADMIN_PATH, post(post_monetization_settings_admin))
        .route(
            ECONOMY_SETTINGS_PERSIST_PATH,
            post(post_economy_settings_persist),
        )
        .route(
            EXCHANGE_SETTINGS_PERSIST_PATH,
            post(post_exchange_settings_persist),
        )
        .route(
            MONETIZATION_SETTINGS_PERSIST_PATH,
            post(post_monetization_settings_persist),
        )
        .route(DISPLAY_LABELS_PATH, post(post_display_labels))
        .route(PROFILE_STATE_PATH, post(post_profile_state))
        .route(PROFILE_IDENTITY_PATH, post(post_profile_identity))
        .route(
            PROFILE_PASSWORD_CHANGE_PATH,
            post(post_profile_password_change),
        )
        .route(
            PROFILE_SECURITY_EVENTS_PATH,
            post(post_profile_security_events),
        )
        .route(
            PROFILE_WALLET_CHALLENGE_PATH,
            post(post_profile_wallet_challenge),
        )
        .route(PROFILE_WALLET_VERIFY_PATH, post(post_profile_wallet_verify))
        .route(PROFILE_WALLET_GET_PATH, post(post_profile_wallet_get))
        .route(PROFILE_WALLET_REMOVE_PATH, post(post_profile_wallet_remove))
        .route(PROFILE_REFERRAL_BIND_PATH, post(post_profile_referral_bind))
        .route(
            PROFILE_REFERRAL_STATE_PATH,
            post(post_profile_referral_state),
        )
        .route(
            PROFILE_REFERRAL_OVERVIEW_PATH,
            post(post_profile_referral_overview),
        )
        .route(PARTNER_GAMES_CONFIG_PATH, post(post_partner_games_config))
        .route(PARTNER_GAMES_VISIT_PATH, post(post_partner_games_visit))
        .route(
            PARTNER_GAMES_HEARTBEAT_PATH,
            post(post_partner_games_heartbeat),
        )
        .route(PARTNER_GAMES_STOP_PATH, post(post_partner_games_stop))
        .route(DASHBOARD_STATE_PATH, post(post_dashboard_state))
        .route(PARTNERS_STATE_PATH, post(post_partners_state))
        .route(PARTNERS_VIDEOS_PATH, post(post_partners_videos))
        .route(PARTNERS_VIDEO_BY_ID_PATH, post(post_partners_video_by_id))
        .route(
            PARTNERS_MY_SUBMISSIONS_PATH,
            post(post_partners_my_submissions),
        )
        .route(PARTNERS_SUBMIT_PATH, post(post_partners_submit))
        .route(PARTNERS_APPLY_PATH, post(post_partners_apply))
        .route(PARTNERS_PROFILE_PATH, post(post_partners_profile))
        .route(
            PARTNERS_ADMIN_APPLICATIONS_LIST_PATH,
            post(post_partners_admin_applications_list),
        )
        .route(
            PARTNERS_ADMIN_APPLICATION_APPROVE_PATH,
            post(post_partners_admin_application_approve),
        )
        .route(
            PARTNERS_ADMIN_APPLICATION_REJECT_PATH,
            post(post_partners_admin_application_reject),
        )
        .route(
            PARTNERS_ADMIN_PARTNERS_LIST_PATH,
            post(post_partners_admin_partners_list),
        )
        .route(
            PARTNERS_ADMIN_STREAMER_USERS_PATH,
            post(post_partners_admin_streamer_users),
        )
        .route(
            PARTNERS_ADMIN_ALLOWLIST_ADD_PATH,
            post(post_partners_admin_allowlist_add),
        )
        .route(
            PARTNERS_ADMIN_ALLOWLIST_REMOVE_PATH,
            post(post_partners_admin_allowlist_remove),
        )
        .route(
            PARTNERS_ADMIN_SUBMISSIONS_LIST_PATH,
            post(post_partners_admin_submissions_list),
        )
        .route(
            PARTNERS_ADMIN_SUBMISSION_REJECT_PATH,
            post(post_partners_admin_submission_reject),
        )
        .route(
            PARTNERS_ADMIN_SUBMISSION_DELETE_PATH,
            post(post_partners_admin_submission_delete),
        )
        .route(
            PARTNERS_ADMIN_CREATOR_GET_PATH,
            post(post_partners_admin_creator_get),
        )
        .route(
            PARTNERS_ADMIN_CREATOR_PUT_PATH,
            post(post_partners_admin_creator_put),
        )
        .route(GUIDE_PATH, post(post_guide))
        .route(ROADMAP_PATH, post(post_roadmap))
        .route(TRANSPARENCY_PATH, post(post_transparency))
        .route(TRANSPARENCY_HEALTH_PATH, post(post_transparency_health))
        .route(
            crate::transparency_admin::TRANSPARENCY_ADMIN_CREATE_PATH,
            post(post_transparency_admin_create),
        )
        .route(
            crate::transparency_admin::TRANSPARENCY_ADMIN_UPDATE_PATH,
            post(post_transparency_admin_update),
        )
        .route(
            crate::transparency_admin::TRANSPARENCY_ADMIN_DELETE_PATH,
            post(post_transparency_admin_delete),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_worker_auth,
        ));

    Router::new()
        .route("/health", get(health))
        .merge(protected)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> StatusCode {
    StatusCode::OK
}

async fn post_partner_games_config(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartnerGamesUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_partner_games_config(&state.pool, &state.cfg, body.user_id).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (
            StatusCode::from_u16(e.http_status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(e.body),
        )
            .into_response(),
    }
}

fn partners_status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

async fn post_dashboard_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DashboardStateRequest>,
) -> impl axum::response::IntoResponse {
    match run_dashboard_state(&state.pool, &state.ranking, body.user_id).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (partners_status(e.http_status), Json(e.body)).into_response(),
    }
}

async fn post_partners_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartnersStateRequest>,
) -> impl axum::response::IntoResponse {
    match run_partners_state(&state.pool, body).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (partners_status(e.http_status), Json(e.body)).into_response(),
    }
}

async fn post_partners_videos(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartnersVideosRequest>,
) -> impl axum::response::IntoResponse {
    match run_partners_videos(&state.pool, body).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (partners_status(e.http_status), Json(e.body)).into_response(),
    }
}

async fn post_partners_video_by_id(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartnersVideoByIdRequest>,
) -> impl axum::response::IntoResponse {
    match run_partners_video_by_id(&state.pool, &body.public_id).await {
        Ok((status, v)) => (partners_status(status), Json(v)).into_response(),
        Err(e) => (partners_status(e.http_status), Json(e.body)).into_response(),
    }
}

async fn post_partners_my_submissions(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartnersUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_my_submissions(&state.pool, body.user_id).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (partners_status(e.http_status), Json(e.body)).into_response(),
    }
}

async fn post_partners_submit(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartnersSubmitRequest>,
) -> impl axum::response::IntoResponse {
    match run_submit_video(&state.pool, body).await {
        Ok((status, v)) => (partners_status(status), Json(v)).into_response(),
        Err(e) => (partners_status(e.http_status), Json(e.body)).into_response(),
    }
}

async fn post_partners_apply(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartnersApplyRequest>,
) -> impl axum::response::IntoResponse {
    match run_partners_apply(&state.pool, body).await {
        Ok((status, v)) => (partners_status(status), Json(v)).into_response(),
        Err(e) => (partners_status(e.http_status), Json(e.body)).into_response(),
    }
}

async fn post_partners_profile(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartnersProfileRequest>,
) -> impl axum::response::IntoResponse {
    match run_profile_update(&state.pool, body).await {
        Ok((status, v)) => (partners_status(status), Json(v)).into_response(),
        Err(e) => (partners_status(e.http_status), Json(e.body)).into_response(),
    }
}

macro_rules! partners_admin_handler {
    ($name:ident, $req:ty, $run:ident) => {
        async fn $name(
            State(state): State<Arc<AppState>>,
            Json(body): Json<$req>,
        ) -> impl axum::response::IntoResponse {
            match $run(&state.pool, body).await {
                Ok((status, v)) => (partners_status(status), Json(v)).into_response(),
                Err(e) => (partners_status(e.http_status), Json(e.body)).into_response(),
            }
        }
    };
}

partners_admin_handler!(
    post_partners_admin_applications_list,
    PartnersAdminListRequest,
    run_admin_applications_list
);
partners_admin_handler!(
    post_partners_admin_application_approve,
    PartnersAdminIdActionRequest,
    run_admin_application_approve
);
partners_admin_handler!(
    post_partners_admin_application_reject,
    PartnersAdminIdActionRequest,
    run_admin_application_reject
);
partners_admin_handler!(
    post_partners_admin_allowlist_add,
    PartnersAdminAllowlistAddRequest,
    run_admin_allowlist_add
);
partners_admin_handler!(
    post_partners_admin_allowlist_remove,
    PartnersAdminUserIdRequest,
    run_admin_allowlist_remove
);
partners_admin_handler!(
    post_partners_admin_submissions_list,
    PartnersAdminListRequest,
    run_admin_submissions_list
);
partners_admin_handler!(
    post_partners_admin_submission_reject,
    PartnersAdminIdActionRequest,
    run_admin_submission_reject
);
partners_admin_handler!(
    post_partners_admin_submission_delete,
    PartnersAdminIdRequest,
    run_admin_submission_delete
);
partners_admin_handler!(
    post_partners_admin_creator_get,
    PartnersAdminUserIdRequest,
    run_admin_creator_get
);
partners_admin_handler!(
    post_partners_admin_creator_put,
    PartnersAdminCreatorPutRequest,
    run_admin_creator_put
);

async fn post_partners_admin_partners_list(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_admin_partners_list(&state.pool).await {
        Ok((status, v)) => (partners_status(status), Json(v)).into_response(),
        Err(e) => (partners_status(e.http_status), Json(e.body)).into_response(),
    }
}

async fn post_partners_admin_streamer_users(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_admin_streamer_room_users(&state.pool).await {
        Ok((status, v)) => (partners_status(status), Json(v)).into_response(),
        Err(e) => (partners_status(e.http_status), Json(e.body)).into_response(),
    }
}

async fn post_partner_games_visit(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartnerGamesUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_partner_games_visit(
        &state.pool,
        &state.cfg,
        &state.kafka,
        body.user_id,
        body.now_ms,
    )
    .await
    {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (
            StatusCode::from_u16(e.http_status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(e.body),
        )
            .into_response(),
    }
}

async fn post_partner_games_heartbeat(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartnerGamesUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_partner_games_heartbeat(
        &state.pool,
        &state.cfg,
        &state.locks,
        &state.kafka,
        body.user_id,
        body.now_ms,
    )
    .await
    {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (
            StatusCode::from_u16(e.http_status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(e.body),
        )
            .into_response(),
    }
}

async fn post_partner_games_stop(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartnerGamesUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_partner_games_stop(
        &state.pool,
        &state.cfg,
        &state.kafka,
        body.user_id,
        body.now_ms,
    )
    .await
    {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (
            StatusCode::from_u16(e.http_status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(e.body),
        )
            .into_response(),
    }
}

async fn post_checkin_status(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CheckinUserRequest>,
) -> impl axum::response::IntoResponse {
    let now = body.now_ms.unwrap_or_else(now_ms);
    match run_checkin_status(&state.pool, body.user_id, now).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_checkin_perform(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CheckinUserRequest>,
) -> impl axum::response::IntoResponse {
    let now = body.now_ms.unwrap_or_else(now_ms);
    match run_checkin_perform(&state.pool, body.user_id, now).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_quests_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CheckinUserRequest>,
) -> impl axum::response::IntoResponse {
    let now = body.now_ms.unwrap_or_else(now_ms);
    match run_quests_state(&state.pool, body.user_id, now).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_dashboard_stats(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_dashboard_stats(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_dashboard_metrics(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_site_metrics(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_dashboard_ranking_exclusion(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RankingExclusionRequest>,
) -> impl axum::response::IntoResponse {
    match run_ranking_exclusion(&state.pool, body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_dashboard_users_map(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_users_map(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_quests_admin_list(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_quests_admin_list(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_quests_admin_save(
    State(state): State<Arc<AppState>>,
    Json(body): Json<QuestSaveRequest>,
) -> impl axum::response::IntoResponse {
    match run_quests_admin_save(&state.pool, body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_player_header(
    State(state): State<Arc<AppState>>,
    Json(body): Json<HeaderRequest>,
) -> impl axum::response::IntoResponse {
    match run_header(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_player_header_highlight(
    State(state): State<Arc<AppState>>,
    Json(body): Json<HeaderHighlightRequest>,
) -> impl axum::response::IntoResponse {
    match run_header_highlight(&state.pool, body.user_id, &body.coin_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_player_nav(
    State(state): State<Arc<AppState>>,
    Json(body): Json<NavRequest>,
) -> impl axum::response::IntoResponse {
    match run_nav(&state.pool, body.user_id, body.managing.unwrap_or(false)).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_economy_settings(
    State(state): State<Arc<AppState>>,
    Json(_body): Json<serde_json::Value>,
) -> impl axum::response::IntoResponse {
    match run_economy_settings(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_exchange_settings(
    State(state): State<Arc<AppState>>,
    Json(_body): Json<serde_json::Value>,
) -> impl axum::response::IntoResponse {
    match run_exchange_settings(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_monetization_settings_admin(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_monetization_settings_admin(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_monetization_settings(
    State(state): State<Arc<AppState>>,
    Json(_body): Json<serde_json::Value>,
) -> impl axum::response::IntoResponse {
    match run_monetization_settings(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_economy_settings_persist(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SettingsPersistRequest>,
) -> impl axum::response::IntoResponse {
    match run_persist_economy_settings(&state.pool, &body.payload).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_exchange_settings_persist(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SettingsPersistRequest>,
) -> impl axum::response::IntoResponse {
    match run_persist_exchange_settings(&state.pool, &body.payload).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_monetization_settings_persist(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SettingsPersistRequest>,
) -> impl axum::response::IntoResponse {
    match run_persist_monetization_settings(&state.pool, &body.payload).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_display_labels(
    State(state): State<Arc<AppState>>,
    Json(_body): Json<serde_json::Value>,
) -> impl axum::response::IntoResponse {
    match run_display_labels(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_profile_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProfileRequest>,
) -> impl axum::response::IntoResponse {
    match run_profile_state(&state.pool, body.user_id, body.invite_base_url.as_deref()).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_profile_identity(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProfileIdentityRequest>,
) -> impl axum::response::IntoResponse {
    let display = body.username.as_deref().or(body.display_name.as_deref());
    match run_patch_identity(
        &state.pool,
        body.user_id,
        display,
        body.request_id.as_deref(),
        body.route.as_deref(),
    )
    .await
    {
        Ok(v) => ok_write(v),
        Err(e) => fail_write(e),
    }
}

async fn post_profile_password_change(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProfilePasswordChangeRequest>,
) -> impl axum::response::IntoResponse {
    match run_change_password(
        &state.pool,
        &state.http,
        &state.cfg,
        body.user_id,
        body.current_password.as_deref(),
        body.new_password.as_deref(),
        body.confirm_password.as_deref(),
        body.request_id.as_deref(),
        body.route.as_deref(),
    )
    .await
    {
        Ok(v) => ok_write(v),
        Err(e) => fail_write(e),
    }
}

async fn post_profile_security_events(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProfileSecurityEventsRequest>,
) -> impl axum::response::IntoResponse {
    let limit = body.limit.unwrap_or(SECURITY_EVENTS_CONTROLLER_LIMIT);
    match list_profile_security_events(&state.pool, body.user_id, limit).await {
        Ok(v) => ok_write(v),
        Err(e) => fail_write(e),
    }
}

async fn post_profile_wallet_challenge(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProfileWalletUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_wallet_challenge(&state.pool, body.user_id).await {
        Ok(v) => ok_write(v),
        Err(e) => fail_write(e),
    }
}

async fn post_profile_wallet_verify(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProfileWalletVerifyRequest>,
) -> impl axum::response::IntoResponse {
    match run_wallet_verify(
        &state.pool,
        body.user_id,
        body.challenge_id.as_deref(),
        body.address.as_deref(),
        body.signature.as_deref(),
        body.chain_id.as_ref(),
        body.request_id.as_deref(),
        body.route.as_deref(),
        body.client_ip.as_deref(),
        body.user_agent.as_deref(),
    )
    .await
    {
        Ok(v) => ok_write(v),
        Err(e) => fail_write(e),
    }
}

async fn post_profile_wallet_get(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProfileWalletUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_wallet_get(&state.pool, body.user_id, body.history_limit).await {
        Ok(v) => ok_write(v),
        Err(e) => fail_write(e),
    }
}

async fn post_profile_wallet_remove(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProfileWalletUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_wallet_remove(
        &state.pool,
        body.user_id,
        body.request_id.as_deref(),
        body.route.as_deref(),
        body.client_ip.as_deref(),
        body.user_agent.as_deref(),
    )
    .await
    {
        Ok(v) => ok_write(v),
        Err(e) => fail_write(e),
    }
}

async fn post_profile_referral_bind(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProfileReferralBindRequest>,
) -> impl axum::response::IntoResponse {
    match run_referral_bind(
        &state.pool,
        body.user_id,
        body.code.as_deref(),
        body.request_id.as_deref(),
        body.route.as_deref(),
    )
    .await
    {
        Ok(v) => ok_write(v),
        Err(e) => fail_write(e),
    }
}

async fn post_profile_referral_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProfileReferralReadRequest>,
) -> impl axum::response::IntoResponse {
    match run_referral_state(&state.pool, body.user_id, body.invite_base_url.as_deref()).await {
        Ok(v) => ok_write(v),
        Err(e) => fail_write(e),
    }
}

async fn post_profile_referral_overview(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProfileReferralReadRequest>,
) -> impl axum::response::IntoResponse {
    let limit = body.history_limit.or(Some(OVERVIEW_HISTORY_LIMIT));
    match run_referral_overview(
        &state.pool,
        body.user_id,
        body.invite_base_url.as_deref(),
        limit,
    )
    .await
    {
        Ok(v) => ok_write(v),
        Err(e) => fail_write(e),
    }
}

async fn post_guide(State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
    match run_guide(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_roadmap(State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
    match run_roadmap(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_transparency(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_transparency_list(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_transparency_health(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_transparency_health(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

fn transparency_admin_id(body: &serde_json::Value) -> Result<i32, crate::player_reads::PlayerReadError> {
    let raw = body.get("id");
    let n = match raw {
        Some(serde_json::Value::Number(n)) => n.as_i64(),
        Some(serde_json::Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    };
    match n {
        Some(v) if v >= 1 && v <= i64::from(i32::MAX) => Ok(v as i32),
        _ => Err(crate::player_reads::PlayerReadError::bad("ID inválido")),
    }
}

async fn post_transparency_admin_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl axum::response::IntoResponse {
    match crate::transparency_admin::run_transparency_create(&state.pool, &body, now_ms()).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_transparency_admin_update(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl axum::response::IntoResponse {
    let id = match transparency_admin_id(&body) {
        Ok(v) => v,
        Err(e) => return fail_read(e),
    };
    match crate::transparency_admin::run_transparency_update(&state.pool, id, &body, now_ms()).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_transparency_admin_delete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl axum::response::IntoResponse {
    let id = match transparency_admin_id(&body) {
        Ok(v) => v,
        Err(e) => return fail_read(e),
    };
    match crate::transparency_admin::run_transparency_delete(&state.pool, id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn require_worker_auth(
    State(state): State<Arc<AppState>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    match state.cfg.mining_worker_auth_token.as_deref() {
        Some(expected) => {
            let provided = request
                .headers()
                .get(MINING_WORKER_AUTH_HEADER)
                .and_then(|v| v.to_str().ok());
            if provided != Some(expected) {
                return Err(StatusCode::UNAUTHORIZED);
            }
        }
        None => {
            // Dev-only: token unset — allow (startup already warned once).
        }
    }
    Ok(next.run(request).await)
}

async fn post_progress(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProgressRequest>,
) -> (StatusCode, Json<ProgressResult>) {
    let result = compute_progress_for_user(
        &state.pool,
        &state.locks,
        &state.cfg,
        &state.kafka,
        body.user_id,
    )
    .await;
    let status = if result.ok {
        StatusCode::OK
    } else {
        StatusCode::UNPROCESSABLE_ENTITY
    };
    (status, Json(result))
}

async fn post_gerente_payout(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GerentePayoutRequest>,
) -> (StatusCode, Json<GerentePayoutResult>) {
    let now_ms = body.server_now_ms.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    });
    let result = pay_closed_manager_weeks(&state.pool, &state.cfg, now_ms).await;
    let status = if result.ok {
        StatusCode::OK
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    (status, Json(result))
}

async fn post_gerente_me(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GerenteMeRequest>,
) -> impl axum::response::IntoResponse {
    match run_me(&state.pool, &state.cfg, body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_gerente_hire(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GerenteTargetRequest>,
) -> impl axum::response::IntoResponse {
    match run_hire(&state.pool, &state.cfg, body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_gerente_apply(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GerenteTargetRequest>,
) -> impl axum::response::IntoResponse {
    match run_apply(&state.pool, &state.cfg, body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_gerente_accept(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GerenteContractIdRequest>,
) -> impl axum::response::IntoResponse {
    match run_accept(&state.pool, &state.cfg, body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_gerente_decline(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GerenteContractIdRequest>,
) -> impl axum::response::IntoResponse {
    match run_decline(&state.pool, &state.cfg, body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_gerente_fire(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GerenteActorRequest>,
) -> impl axum::response::IntoResponse {
    match run_fire(&state.pool, &state.cfg, &state.http, body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_gerente_resign(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GerenteResignRequest>,
) -> impl axum::response::IntoResponse {
    match run_resign(&state.pool, &state.cfg, &state.http, body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_gerente_enter(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GerenteEnterRequest>,
) -> impl axum::response::IntoResponse {
    match run_enter(&state.pool, &state.cfg, &state.http, body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_gerente_leave(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GerenteEnterRequest>,
) -> impl axum::response::IntoResponse {
    match run_leave(&state.pool, &state.cfg, &state.http, body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn get_ranking_public(
    State(state): State<Arc<AppState>>,
    Query(q): Query<RankingPublicQuery>,
) -> Result<Json<PublicMiningRankingPayload>, StatusCode> {
    let fresh = q.fresh.unwrap_or(false);
    match state.ranking.get_public(fresh).await {
        Ok(p) => Ok(Json(p)),
        Err(e) => {
            warn!(err = %e, "ranking public failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn get_ranking_me(
    State(state): State<Arc<AppState>>,
    Query(q): Query<RankingMeQuery>,
) -> Result<Json<MyGlobalMiningRank>, StatusCode> {
    let user_id = q.user_id.unwrap_or(0);
    let fresh = q.fresh.unwrap_or(false);
    match state.ranking.get_my_rank(user_id, fresh).await {
        Ok(p) => Ok(Json(p)),
        Err(e) => {
            warn!(err = %e, "ranking me failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn get_ranking_admin(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AdminMiningRankingPayload>, StatusCode> {
    match state.ranking.get_admin().await {
        Ok(p) => Ok(Json(p)),
        Err(e) => {
            warn!(err = %e, "ranking admin failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn post_ranking_refresh(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PublicMiningRankingPayload>, StatusCode> {
    match state.ranking.refresh_snapshot().await {
        Ok(p) => Ok(Json(p)),
        Err(e) => {
            warn!(err = %e, "ranking refresh failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

fn status_from_u16(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

async fn post_chat_insert(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatInsertRequest>,
) -> (StatusCode, Json<ChatInsertResponse>) {
    match run_chat_insert(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "chat insert failed");
            }
            (status, Json(ChatInsertResponse::from_err(e)))
        }
    }
}

async fn post_chat_edit(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatEditRequest>,
) -> (StatusCode, Json<ChatEditResponse>) {
    match run_chat_edit(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "chat edit failed");
            }
            (status, Json(ChatEditResponse::from_err(e)))
        }
    }
}

async fn post_chat_delete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatDeleteRequest>,
) -> (StatusCode, Json<ChatDeleteResponse>) {
    match run_chat_delete(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "chat delete failed");
            }
            (status, Json(ChatDeleteResponse::from_err(e)))
        }
    }
}

async fn post_support_submit(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportSubmitRequest>,
) -> (StatusCode, Json<SupportSubmitResponse>) {
    match run_support_submit(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support submit failed");
            }
            (status, Json(SupportSubmitResponse::from_err(e)))
        }
    }
}

async fn post_support_reply(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportReplyRequest>,
) -> (StatusCode, Json<SupportReplyResponse>) {
    match run_support_reply(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support reply failed");
            }
            (status, Json(SupportReplyResponse::from_err(e)))
        }
    }
}

async fn post_support_admin_tickets_payload(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportAdminTicketsPayloadRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_support_admin_tickets_payload(&state.pool, body).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => support_read_err_json(e),
    }
}

async fn post_support_admin_ticket_payload(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportAdminTicketPayloadRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_support_admin_ticket_payload(&state.pool, body).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => support_read_err_json(e),
    }
}

async fn post_support_admin_user_history(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportAdminUserHistoryRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_support_admin_user_history_payload(&state.pool, body).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => support_read_err_json(e),
    }
}

async fn post_support_admin_status_toggle(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportAdminStatusRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_support_admin_status(&state.pool, body).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => support_read_err_json(e),
    }
}

fn support_read_err_json(
    e: crate::support_reads::SupportReadError,
) -> (StatusCode, Json<serde_json::Value>) {
    let status = status_from_u16(e.http_status);
    if status.is_server_error() {
        warn!(err = %e.message, "support admin payload failed");
    }
    (
        status,
        Json(serde_json::json!({ "ok": false, "error": e.message, "code": e.code })),
    )
}

async fn post_support_admin_reply(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportAdminReplyRequest>,
) -> (StatusCode, Json<SupportAdminReplyResponse>) {
    match run_support_admin_reply(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support admin reply failed");
            }
            (status, Json(SupportAdminReplyResponse::from_err(e)))
        }
    }
}

async fn post_support_list_mine(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportListMineRequest>,
) -> (StatusCode, Json<SupportListMineResponse>) {
    match run_support_list_mine(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support list-mine failed");
            }
            (status, Json(SupportListMineResponse::from_err(e)))
        }
    }
}

async fn post_support_get(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportGetRequest>,
) -> (StatusCode, Json<SupportGetResponse>) {
    match run_support_get(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support get failed");
            }
            (status, Json(SupportGetResponse::from_err(e)))
        }
    }
}

async fn post_support_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportStateRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_support_state(&state.pool, body).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support state failed");
            }
            (
                status,
                Json(serde_json::json!({
                    "ok": false,
                    "error": e.message,
                    "code": e.code,
                })),
            )
        }
    }
}

async fn post_support_archive(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportStatusChangeRequest>,
) -> (StatusCode, Json<SupportStatusChangeResponse>) {
    match run_support_archive(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support archive failed");
            }
            (status, Json(SupportStatusChangeResponse::from_err(e)))
        }
    }
}

async fn post_support_reopen(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportStatusChangeRequest>,
) -> (StatusCode, Json<SupportStatusChangeResponse>) {
    match run_support_reopen(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support reopen failed");
            }
            (status, Json(SupportStatusChangeResponse::from_err(e)))
        }
    }
}

async fn post_support_admin_list(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportAdminListRequest>,
) -> (StatusCode, Json<SupportAdminListResponse>) {
    match run_support_admin_list(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support admin list failed");
            }
            (status, Json(SupportAdminListResponse::from_err(e)))
        }
    }
}

async fn post_support_admin_get(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportAdminGetRequest>,
) -> (StatusCode, Json<SupportAdminGetResponse>) {
    match run_support_admin_get(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support admin get failed");
            }
            (status, Json(SupportAdminGetResponse::from_err(e)))
        }
    }
}

async fn post_support_admin_history(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportAdminHistoryRequest>,
) -> (StatusCode, Json<SupportAdminHistoryResponse>) {
    match run_support_admin_history(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support admin history failed");
            }
            (status, Json(SupportAdminHistoryResponse::from_err(e)))
        }
    }
}

async fn post_support_admin_stats(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportAdminStatsRequest>,
) -> (StatusCode, Json<SupportAdminStatsResponse>) {
    match run_support_admin_stats(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support admin stats failed");
            }
            (status, Json(SupportAdminStatsResponse::from_err(e)))
        }
    }
}

async fn post_chat_history(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatHistoryRequest>,
) -> (StatusCode, Json<ChatHistoryResponse>) {
    match run_chat_history(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "chat history failed");
            }
            (status, Json(ChatHistoryResponse::from_err(e)))
        }
    }
}

async fn post_chat_get(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatGetRequest>,
) -> (StatusCode, Json<ChatGetResponse>) {
    match run_chat_get(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "chat get failed");
            }
            (status, Json(ChatGetResponse::from_err(e)))
        }
    }
}

async fn post_chat_sender(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatSenderRequest>,
) -> (StatusCode, Json<ChatSenderResponse>) {
    match run_chat_sender(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "chat sender failed");
            }
            (status, Json(ChatSenderResponse::from_err(e)))
        }
    }
}

async fn post_chat_peers(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatPeersRequest>,
) -> (StatusCode, Json<ChatPeersResponse>) {
    match run_chat_peers(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "chat peers failed");
            }
            (status, Json(ChatPeersResponse::from_err(e)))
        }
    }
}

async fn post_chat_mentions_search(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatMentionsSearchRequest>,
) -> (StatusCode, Json<ChatMentionsResponse>) {
    match run_chat_mentions_search(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "chat mentions-search failed");
            }
            (status, Json(ChatMentionsResponse::from_err(e)))
        }
    }
}

async fn post_chat_can_access(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatCanAccessRequest>,
) -> (StatusCode, Json<ChatCanAccessResponse>) {
    match run_chat_can_access(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "chat can-access failed");
            }
            (status, Json(ChatCanAccessResponse::from_err(e)))
        }
    }
}

async fn post_chat_rate_limit(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatRateLimitRequest>,
) -> (StatusCode, Json<ChatRateLimitResponse>) {
    match run_chat_rate_limit(&state.locks, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "chat rate-limit failed");
            }
            (status, Json(ChatRateLimitResponse::from_err(e)))
        }
    }
}

async fn post_chat_presence(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatPresenceRequest>,
) -> (StatusCode, Json<ChatPresenceResponse>) {
    match run_chat_presence(&state.locks, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "chat presence failed");
            }
            (status, Json(ChatPresenceResponse::from_err(e)))
        }
    }
}

async fn post_assert_active_user(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AssertActiveRequest>,
) -> (StatusCode, Json<AssertActiveResponse>) {
    match run_assert_active_user(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "assert-active failed");
            }
            (status, Json(AssertActiveResponse::from_err(e)))
        }
    }
}

async fn post_admin_gate(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminGateRequest>,
) -> impl axum::response::IntoResponse {
    match run_admin_gate(&state.pool, body).await {
        Ok(ctx) => ok_payload(ctx.payload()),
        Err(e) => fail_read(e),
    }
}

async fn post_admin_users_list(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminUsersListRequest>,
) -> impl axum::response::IntoResponse {
    match run_admin_users_list(&state.pool, &body.query).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_admin_users_block(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminUsersBlockRequest>,
) -> impl axum::response::IntoResponse {
    match run_admin_block_user(&state.pool, &body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_admin_users_update(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminUserUpdateRequest>,
) -> impl axum::response::IntoResponse {
    match run_admin_update_user(&state.pool, &state.http, &state.cfg, &body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_admin_users_delete_resolve(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminUserDeleteRequest>,
) -> impl axum::response::IntoResponse {
    match run_admin_delete_resolve(&state.pool, &body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_admin_users_delete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminUserDeleteRequest>,
) -> impl axum::response::IntoResponse {
    match run_admin_delete_user(&state.pool, &state.http, &state.cfg, &body).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_support_ticket_for_player(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportTicketForPlayerRequest>,
) -> (StatusCode, Json<SupportTicketForPlayerResponse>) {
    match run_support_ticket_for_player(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support ticket-for-player failed");
            }
            (status, Json(SupportTicketForPlayerResponse::from_err(e)))
        }
    }
}

async fn post_support_attachment_referenced(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SupportAttachmentReferencedRequest>,
) -> (StatusCode, Json<SupportAttachmentReferencedResponse>) {
    match run_support_attachment_referenced(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "support attachment-referenced failed");
            }
            (
                status,
                Json(SupportAttachmentReferencedResponse::from_err(e)),
            )
        }
    }
}

async fn post_announcement_get(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AnnouncementGetRequest>,
) -> (StatusCode, Json<AnnouncementWriteResponse>) {
    match run_announcement_get(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "announcement get failed");
            }
            (status, Json(AnnouncementWriteResponse::from_err(e)))
        }
    }
}

async fn post_upload_chat_audio(
    State(state): State<Arc<AppState>>,
    multipart: Multipart,
) -> (StatusCode, Json<UploadWriteResponse>) {
    match run_upload_chat_audio(&state.cfg, multipart).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "upload chat-audio failed");
            }
            (status, Json(UploadWriteResponse::from_err(e)))
        }
    }
}

async fn post_upload_support_attachment(
    State(state): State<Arc<AppState>>,
    multipart: Multipart,
) -> (StatusCode, Json<UploadWriteResponse>) {
    match run_upload_support_attachment(&state.cfg, multipart).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "upload support-attachment failed");
            }
            (status, Json(UploadWriteResponse::from_err(e)))
        }
    }
}

async fn post_upload_partner_avatar(
    State(state): State<Arc<AppState>>,
    multipart: Multipart,
) -> (StatusCode, Json<UploadWriteResponse>) {
    match run_upload_partner_avatar(&state.cfg, multipart).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "upload partner-avatar failed");
            }
            (status, Json(UploadWriteResponse::from_err(e)))
        }
    }
}

async fn post_upload_admin_image_data_url(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminImageDataUrlRequest>,
) -> (StatusCode, Json<UploadWriteResponse>) {
    match run_upload_admin_image_data_url(&state.cfg, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "upload admin-image-data-url failed");
            }
            (status, Json(UploadWriteResponse::from_err(e)))
        }
    }
}

async fn post_chat_mentions_resolve(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatMentionsResolveRequest>,
) -> (StatusCode, Json<ChatMentionsResponse>) {
    match run_chat_mentions_resolve(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "chat mentions-resolve failed");
            }
            (status, Json(ChatMentionsResponse::from_err(e)))
        }
    }
}

async fn post_announcement_pending(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AnnouncementUserListRequest>,
) -> (StatusCode, Json<AnnouncementListResponse>) {
    match run_announcement_pending(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "announcement pending failed");
            }
            (status, Json(AnnouncementListResponse::from_err(e)))
        }
    }
}

async fn post_announcement_mini_blog(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AnnouncementUserListRequest>,
) -> (StatusCode, Json<AnnouncementListResponse>) {
    match run_announcement_mini_blog(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "announcement mini-blog failed");
            }
            (status, Json(AnnouncementListResponse::from_err(e)))
        }
    }
}

async fn post_announcement_admin_list(
    State(state): State<Arc<AppState>>,
) -> (StatusCode, Json<AnnouncementAdminListResponse>) {
    match run_announcement_admin_list(&state.pool).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "announcement admin-list failed");
            }
            (status, Json(AnnouncementAdminListResponse::from_err(e)))
        }
    }
}

async fn post_announcement_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AnnouncementCreateRequest>,
) -> (StatusCode, Json<AnnouncementWriteResponse>) {
    match run_announcement_create(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "announcement create failed");
            }
            (status, Json(AnnouncementWriteResponse::from_err(e)))
        }
    }
}

async fn post_announcement_update(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AnnouncementUpdateRequest>,
) -> (StatusCode, Json<AnnouncementWriteResponse>) {
    match run_announcement_update(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "announcement update failed");
            }
            (status, Json(AnnouncementWriteResponse::from_err(e)))
        }
    }
}

async fn post_announcement_delete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AnnouncementDeleteRequest>,
) -> (StatusCode, Json<AnnouncementWriteResponse>) {
    match run_announcement_delete(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "announcement delete failed");
            }
            (status, Json(AnnouncementWriteResponse::from_err(e)))
        }
    }
}

async fn post_announcement_mark_read(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AnnouncementMarkReadRequest>,
) -> (StatusCode, Json<AnnouncementWriteResponse>) {
    match run_announcement_mark_read(&state.pool, body).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            let status = status_from_u16(e.http_status);
            if status.is_server_error() {
                warn!(err = %e.message, "announcement mark-read failed");
            }
            (status, Json(AnnouncementWriteResponse::from_err(e)))
        }
    }
}

async fn post_calculator_snapshot(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CalculatorSnapshotRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_calculator_snapshot(&state.pool, body.user_id, body.scope.as_deref()).await {
        Ok(out) => match serde_json::to_value(&out) {
            Ok(v) => (StatusCode::OK, Json(v)),
            Err(e) => {
                warn!(err = %e, "calculator snapshot serialize failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(
                        serde_json::to_value(&CalculatorSnapshotErrorBody {
                            ok: false,
                            error: "serialize failed".into(),
                            code: "CALCULATOR_IO".into(),
                        })
                        .unwrap_or_else(|_| serde_json::json!({ "ok": false })),
                    ),
                )
            }
        },
        Err(e) => {
            warn_if_server_error(&e);
            let status = status_from_u16(e.http_status);
            (
                status,
                Json(
                    serde_json::to_value(&e.to_body())
                        .unwrap_or_else(|_| serde_json::json!({ "ok": false })),
                ),
            )
        }
    }
}

async fn post_calculator_ai_analyze(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CalculatorAiAnalyzeRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_calculator_ai_analyze(
        &state.pool,
        &state.http,
        &state.cfg,
        body.user_id,
        body.scope.as_deref(),
    )
    .await
    {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (status_from_u16(e.http_status), Json(e.to_body())),
    }
}

async fn post_chat_purge_expired(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatPurgeRequest>,
) -> (StatusCode, Json<ChatPurgeResponse>) {
    match run_purge_expired_chat_messages(&state.pool, body.now_ms, body.limit).await {
        Ok(out) => (StatusCode::OK, Json(out)),
        Err(e) => {
            warn!(err = %e, "chat purge failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ChatPurgeResponse {
                    ok: false,
                    deleted: 0,
                    ids: vec![],
                    channels: vec![],
                    audio_urls: vec![],
                    before_ms: 0,
                    error: Some(e),
                }),
            )
        }
    }
}

pub async fn serve(state: AppState) -> anyhow::Result<()> {
    let port = state.cfg.mining_worker_port;
    if state.cfg.mining_worker_auth_token.is_none() {
        warn!(
            event = "auth_disabled",
            "MINING_WORKER_AUTH_TOKEN unset — worker HTTP auth disabled (dev only)"
        );
    } else {
        info!(
            event = "auth_enabled",
            "worker HTTP requires {}", MINING_WORKER_AUTH_HEADER
        );
    }
    let app = router(state);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "mining worker HTTP listening");
    axum::serve(listener, app).await?;
    Ok(())
}
