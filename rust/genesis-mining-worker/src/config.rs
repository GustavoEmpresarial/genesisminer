//! Env config for the mining worker binary.
//!
//! Interval / retention defaults mirror `yield-cron.ts` (named consts only).

use genesis_core::mining::TEN_MIN_MS;
use genesis_core::time::{MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND};

/// Default HTTP listen port (`MINING_WORKER_PORT` / Compose).
/// Keep in sync with Node `MINING_WORKER_DEFAULT_PORT` in mining-worker-client.ts.
pub const MINING_WORKER_DEFAULT_PORT: u16 = 8091;

/// Auth header for Node → worker progress HTTP.
/// Keep in sync with Node `MINING_WORKER_AUTH_HEADER` in mining-worker-client.ts.
pub const MINING_WORKER_AUTH_HEADER: &str = "x-mining-worker-token";

/// Floor for `MINING_YIELD_CRON_INTERVAL_MS` (15s).
pub const MIN_YIELD_CRON_INTERVAL_MS: u64 = 15 * MS_PER_SECOND;
/// Default tick interval (2 min) when env unset / invalid.
pub const DEFAULT_YIELD_CRON_INTERVAL_MS: u64 = 2 * MS_PER_MINUTE;
/// Startup delay before first tick.
pub const DEFAULT_STARTUP_DELAY_MS: u64 = 5 * MS_PER_SECOND;
/// Log warn when a tick exceeds this wall duration.
pub const SLOW_TICK_LOG_THRESHOLD_MS: u64 = MS_PER_SECOND + MS_PER_SECOND / 2;
/// Rack batch size (cooperative yield between batches).
pub const RACK_SCAN_BATCH_SIZE: usize = 200;
/// Retention window for `mining_yield_history` rows.
pub const HISTORY_RETENTION_HOURS: u64 = 72;
pub const HISTORY_RETENTION_MS: i64 = (HISTORY_RETENTION_HOURS * MS_PER_HOUR) as i64;
/// Catch-up cap: ~12h of 10-min grid (= 72 boundaries).
pub const MAX_YIELD_CATCHUP_HOURS: u64 = 12;
pub const MAX_YIELD_CATCHUP_BOUNDARIES_PER_TICK: usize =
    ((MAX_YIELD_CATCHUP_HOURS * MS_PER_HOUR) as i64 / TEN_MIN_MS) as usize;

/// Redis lock key — mirror `REDIS_LOCK_KEYS.miningYieldTick`.
pub const REDIS_LOCK_MINING_YIELD_TICK: &str = "genesis:lock:mining_yield_tick";
/// TTL seconds — mirror `REDIS_LOCK_TTL_SECONDS.miningYieldTick` (3 min).
pub const REDIS_LOCK_TTL_MINING_YIELD_TICK_SEC: u64 = 3 * (MS_PER_MINUTE / MS_PER_SECOND);
/// Default job timeout for a single yield tick (2 min).
pub const DEFAULT_JOB_TIMEOUT_MINING_YIELD_MS: u64 = 2 * MS_PER_MINUTE;

/// Redis snapshot key — mirror Node `RANKING_REDIS_KEY`.
pub const RANKING_REDIS_KEY: &str = "ranking:public:v1";
/// Redis lock — mirror `REDIS_LOCK_KEYS.jobPublicRanking`.
pub const REDIS_LOCK_JOB_PUBLIC_RANKING: &str = "genesis:lock:job:public-ranking";
/// Lock TTL seconds — mirror `REDIS_LOCK_TTL_SECONDS.publicRanking` (300).
pub const REDIS_LOCK_TTL_PUBLIC_RANKING_SEC: u64 = 5 * (MS_PER_MINUTE / MS_PER_SECOND);
/// Default job timeout — mirror `opsConfig.jobTimeouts.publicRanking` (4 min).
pub const DEFAULT_JOB_TIMEOUT_PUBLIC_RANKING_MS: u64 = 4 * MS_PER_MINUTE;
/// Default refresh interval minutes when `RANKING_REFRESH_INTERVAL_MS` unset.
pub const RANKING_REFRESH_INTERVAL_DEFAULT_MINUTES: u64 = 5;
/// Default refresh interval ms (5 min).
pub const DEFAULT_RANKING_REFRESH_INTERVAL_MS: u64 =
    RANKING_REFRESH_INTERVAL_DEFAULT_MINUTES * MS_PER_MINUTE;
/// Redis TTL = interval × this multiplier (Node `RANKING_REDIS_TTL_SECONDS_MULTIPLIER`).
pub const RANKING_REDIS_TTL_SECONDS_MULTIPLIER: u64 = 3;
/// Local in-process fallback TTL when Redis miss/unavailable (Node `LOCAL_FALLBACK_TTL_SECONDS`).
pub const RANKING_LOCAL_FALLBACK_TTL_SECONDS: u64 = 10;
pub const RANKING_LOCAL_FALLBACK_TTL_MS: u64 = RANKING_LOCAL_FALLBACK_TTL_SECONDS * MS_PER_SECOND;
/// Slow-refresh warn threshold (same as yield `SLOW_TICK_LOG_THRESHOLD_MS`).
pub const RANKING_SLOW_REFRESH_LOG_THRESHOLD_MS: u64 = MS_PER_SECOND + MS_PER_SECOND / 2;
/// Kafka topic for ranking snapshot invalidate events.
pub const KAFKA_TOPIC_RANKING_SNAPSHOT: &str = "genesis.ranking.snapshot";
/// Kafka topic for mining progress header invalidate (Node consumer).
pub const KAFKA_TOPIC_MINING_PROGRESS: &str = "genesis.mining.progress";
/// Dedicated "my rank" cache TTL bounds (Node `MY_RANK_CACHE_TTL_*`).
pub const MY_RANK_CACHE_TTL_DEFAULT_MS: u64 = 10 * MS_PER_SECOND;
pub const MY_RANK_CACHE_TTL_FLOOR_MS: u64 = 5 * MS_PER_SECOND;
pub const MY_RANK_CACHE_TTL_CEILING_MS: u64 = MS_PER_MINUTE;

/// Redis lock — mirror `REDIS_LOCK_KEYS.jobGerentePayout`.
pub const REDIS_LOCK_JOB_GERENTE_PAYOUT: &str = "genesis:lock:job:gerente-payout";
/// Lock TTL seconds — mirror `REDIS_LOCK_TTL_SECONDS.gerentePayout` (3 min).
pub const REDIS_LOCK_TTL_GERENTE_PAYOUT_SEC: u64 = 3 * (MS_PER_MINUTE / MS_PER_SECOND);
/// Default job timeout — mirror `opsConfig.jobTimeouts.gerentePayout` (2 min).
pub const DEFAULT_JOB_TIMEOUT_GERENTE_PAYOUT_MS: u64 = 2 * MS_PER_MINUTE;
/// Poll interval — Node `payout-cron.ts` `TICK_MS = MS_PER_HOUR`.
pub const DEFAULT_GERENTE_PAYOUT_INTERVAL_MS: u64 = MS_PER_HOUR;

/// Redis lock — mirror `REDIS_LOCK_KEYS.jobChatTtl`.
pub const REDIS_LOCK_JOB_CHAT_TTL: &str = "genesis:lock:job:chat-ttl";
/// Lock TTL seconds — mirror `REDIS_LOCK_TTL_SECONDS.chatTtl` (120).
pub const REDIS_LOCK_TTL_CHAT_TTL_SEC: u64 = 2 * (MS_PER_MINUTE / MS_PER_SECOND);
/// Default job timeout — mirror `opsConfig.jobTimeouts.chatTtl` (90s).
pub const DEFAULT_JOB_TIMEOUT_CHAT_TTL_MS: u64 = 90 * MS_PER_SECOND;
/// Poll interval — Node `ttl-cron.ts` `TICK_MS = MS_PER_MINUTE`.
pub const DEFAULT_CHAT_TTL_INTERVAL_MS: u64 = MS_PER_MINUTE;
/// Node `MAX_BATCHES_PER_TICK`.
pub const CHAT_TTL_MAX_BATCHES_PER_TICK: usize = 3;
/// Node `PURGE_BATCH_LIMIT`.
pub const CHAT_TTL_PURGE_BATCH_LIMIT: i64 = 2000;

/// genesis-api `WS_EMIT_CHANNEL` — Socket.IO fanout bus.
pub const WS_EMIT_CHANNEL: &str = "genesis:ws:emit";
/// Socket.IO event after chat TTL purge (clients refresh history).
pub const CHAT_TTL_PURGE_EVENT: &str = "chat:ttl_purge";

/// Redis lock — mirror `REDIS_LOCK_KEYS.jobIdempotencyPurge`.
pub const REDIS_LOCK_JOB_IDEMPOTENCY_PURGE: &str = "genesis:lock:job:idempotency-purge";
/// Lock TTL seconds — mirror `REDIS_LOCK_TTL_SECONDS.idempotencyPurge` (600).
pub const REDIS_LOCK_TTL_IDEMPOTENCY_PURGE_SEC: u64 = 10 * (MS_PER_MINUTE / MS_PER_SECOND);
/// Default job timeout — mirror `opsConfig.jobTimeouts.idempotencyPurge` (5 min).
pub const DEFAULT_JOB_TIMEOUT_IDEMPOTENCY_PURGE_MS: u64 = 5 * MS_PER_MINUTE;
/// Poll interval — Node `idempotency-purge-cron.ts` `TICK_MS = MS_PER_HOUR`.
pub const DEFAULT_IDEMPOTENCY_PURGE_INTERVAL_MS: u64 = MS_PER_HOUR;
/// Node `IDEMPOTENCY_RETENTION_DAYS`.
pub const IDEMPOTENCY_RETENTION_DAYS: i32 = 30;
/// Node `IDEMPOTENCY_PURGE_BATCH`.
pub const IDEMPOTENCY_PURGE_BATCH: i64 = 5_000;
/// Node `MAX_BATCHES_PER_TICK` (idempotency purge).
pub const IDEMPOTENCY_MAX_BATCHES_PER_TICK: usize = 20;

/// Redis lock for the live-price sync loop (owns legacy
/// `maybeSyncLiveUsdToMiningCoinsPostgres`, `lib/miningLivePrices.js`).
pub const REDIS_LOCK_JOB_PRICE_SYNC: &str = "genesis:lock:job:price-sync";
/// Lock TTL seconds — one interval's worth of headroom.
pub const REDIS_LOCK_TTL_PRICE_SYNC_SEC: u64 = 5 * (MS_PER_MINUTE / MS_PER_SECOND);
/// Legacy `DEFAULT_PRICE_DB_SYNC_INTERVAL_MS` (10 min).
pub const DEFAULT_PRICE_SYNC_INTERVAL_MS: u64 = 10 * MS_PER_MINUTE;
/// Per-tick timeout — CoinGecko fetch + a short UPDATE loop.
pub const DEFAULT_JOB_TIMEOUT_PRICE_SYNC_MS: u64 = MS_PER_MINUTE;
/// CoinGecko `simple/price` endpoint (legacy `COINGECKO_SIMPLE`).
pub const COINGECKO_SIMPLE_URL: &str = "https://api.coingecko.com/api/v3/simple/price";

/// Redis lock — mirror `REDIS_LOCK_KEYS.jobBackupSql`.
pub const REDIS_LOCK_JOB_BACKUP_SQL: &str = "genesis:lock:job:backup-sql";
/// Lock TTL seconds — mirror `REDIS_LOCK_TTL_SECONDS.backupSql` (1800).
pub const REDIS_LOCK_TTL_BACKUP_SQL_SEC: u64 = 30 * (MS_PER_MINUTE / MS_PER_SECOND);
/// Default job timeout — mirror `opsConfig.jobTimeouts.backupSql` (1_100_000).
pub const DEFAULT_JOB_TIMEOUT_BACKUP_SQL_MS: u64 = 1_100_000;
/// Max job timeout — mirror `JOB_BACKUP_SQL_MAX_MS` (30 min).
pub const JOB_TIMEOUT_BACKUP_SQL_MAX_MS: u64 = 30 * MS_PER_MINUTE;
/// Node `AUTO_SQL_BACKUP_LOCK_K1`.
pub const AUTO_SQL_BACKUP_LOCK_K1: i32 = 0x4d53;
/// Node `AUTO_SQL_BACKUP_LOCK_K2`.
pub const AUTO_SQL_BACKUP_LOCK_K2: i32 = 0x6270;
/// Hard count cap so a runaway can't fill disk (age-based prune is primary).
pub const DEFAULT_BACKUP_SQL_KEEP: u32 = 30;
/// Node `AUTO_BACKUP_KEEP_MIN`.
pub const AUTO_BACKUP_KEEP_MIN: u32 = 1;
/// Node `AUTO_BACKUP_KEEP_MAX`.
pub const AUTO_BACKUP_KEEP_MAX: u32 = 500;
/// Node `AUTO_SQL_BACKUP_PREFIX`.
pub const AUTO_SQL_BACKUP_PREFIX: &str = "auto_pgdump_";
/// Age-based retention for `auto_pgdump_*` dumps (primary prune). Newest is
/// always kept regardless of age.
pub const DEFAULT_BACKUP_RETENTION_DAYS: u32 = 3;
pub const BACKUP_RETENTION_DAYS_MIN: u32 = 1;
pub const BACKUP_RETENTION_DAYS_MAX: u32 = 90;
/// Custom-format dump extension (`pg_dump -Fc`).
pub const BACKUP_ARCHIVE_EXT: &str = ".dump";
/// Google OAuth2 token endpoint (refresh-token grant).
pub const GOOGLE_OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
/// Node `DEFAULT_BACKUP_DIR_SEGMENTS` joined.
pub const DEFAULT_BACKUP_DIR: &str = "storage/backups";
/// Node `PROFILE_AUDIT_RETENTION_DAYS`.
pub const PROFILE_AUDIT_RETENTION_DAYS: i64 = 90;
/// Node `HOURS_MAX` for `BACKUP_AUTO_LOCAL_HOUR`.
pub const BACKUP_AUTO_HOUR_MAX: u32 = 23;
/// Node `MINUTES_MAX` for `BACKUP_AUTO_LOCAL_MINUTE`.
pub const BACKUP_AUTO_MINUTE_MAX: u32 = 59;
/// Node `SCHEDULE_MIN_DELAY_MS`.
pub const BACKUP_SCHEDULE_MIN_DELAY_MS: u64 = MS_PER_SECOND;
/// Node `POSTGRES_DEFAULT_PORT`.
pub const POSTGRES_DEFAULT_PORT: u16 = 5432;
/// Node pg_dump abort: SIGTERM then SIGKILL after this grace.
/// Rust path uses `kill_on_drop` on the child (job timeout cancels the future).
#[allow(dead_code)]
pub const PG_DUMP_ABORT_KILL_GRACE_MS: u64 = 2 * MS_PER_SECOND;

/// Redis lock TTL for per-user progress (seconds) — `MINING_PROGRESS_LOCK_TTL_SEC`.
pub const LOCK_TTL_SEC_DEFAULT: u64 = 120;
pub const LOCK_TTL_SEC_MIN: u64 = 30;
pub const LOCK_TTL_SEC_MAX: u64 = 600;
/// Offline earning window cap (anti-farm) — mirrors progress-computer.ts.
pub const HOURS_PER_EARNING_WINDOW: u64 = 72;
pub const YIELD_HISTORY_LOOKBACK_HOURS: u64 = 73;
pub const MAX_EARNING_WINDOW_MS: i64 = (HOURS_PER_EARNING_WINDOW * MS_PER_HOUR) as i64;
pub const YIELD_HISTORY_LOOKBACK_MS: i64 = (YIELD_HISTORY_LOOKBACK_HOURS * MS_PER_HOUR) as i64;
/// Reject / clamp client `now` more than this ahead of wall clock.
pub const CLOCK_SKEW_ALLOW_MS: i64 = (5 * MS_PER_MINUTE) as i64;
/// `SET LOCAL statement_timeout` / `lock_timeout` inside progress TX.
pub const PROGRESS_TX_TIMEOUT_MS: u64 = 5 * MS_PER_SECOND;
/// Canonical mined balance decimals (saque/UI).
pub const MINED_COIN_AMOUNT_DECIMALS: i32 = 8;
pub const IDEMPOTENCY_KEY_MAX_LENGTH: usize = 190;
/// Postgres undefined_table — legacy DDL may omit ledger/history.
pub const PG_UNDEFINED_TABLE: &str = "42P01";
pub const PG_INVALID_COLUMN_REFERENCE: &str = "42P10";
pub const PG_UNDEFINED_COLUMN: &str = "42703";

/// Fixed NFT auto room id (same as calculator / nft-room-mining).
pub const NFT_AUTO_ROOM_ID: &str = "room_1777158991085";
/// Policy name keys for `resolveNftAutoArmario1OnlyRoomIds` SQL.
pub const NFT_AUTO_POLICY_ROOM_NAME_KEYS: &[&str] = &[
    "sala nfts",
    "nfts auto",
    "nft auto",
    "nfts arbam",
    "sala dolar/nfts",
    "sala dolar / nfts",
];

/// Canonical ASIC room id (same as `room-kind.ts` / calculator).
pub const ASIC_ROOM_ID: &str = "room_1775484506874";
/// Policy name keys for `resolveAsicRoomIds` SQL (`ASIC_POLICY_ROOM_NAME_KEYS`).
pub const ASIC_POLICY_ROOM_NAME_KEYS: &[&str] = &["sala das asics"];

/// Canonical INSERT — UNIQUE(coin_id, effective_at).
pub const MINING_YIELD_HISTORY_INSERT_SQL: &str = r#"
INSERT INTO mining_yield_history (coin_id, yield_per_hash, block_reward, network_hashrate, effective_at)
SELECT * FROM UNNEST($1::text[], $2::float8[], $3::float8[], $4::float8[], $5::int8[])
ON CONFLICT (coin_id, effective_at) DO NOTHING
"#;

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub database_url: String,
    pub redis_url: Option<String>,
    pub yield_cron_interval_ms: u64,
    pub startup_delay_ms: u64,
    pub scheduler_enabled: bool,
    pub mining_yield_cron_enabled: bool,
    pub mining_yield_scheduler_enabled: bool,
    pub ten_minute_grid_enabled: bool,
    pub redis_locks_enabled: bool,
    pub job_timeout_mining_yield_ms: u64,
    pub kafka_enabled: bool,
    pub kafka_brokers: Option<String>,
    pub kafka_client_id: Option<String>,
    pub mining_worker_port: u16,
    /// Shared secret for `x-mining-worker-token`. `None` = auth disabled (dev only).
    pub mining_worker_auth_token: Option<String>,
    pub mining_progress_lock_ttl_sec: u64,
    pub mining_progress_compute_enabled: bool,
    pub mining_progress_require_redis_lock: bool,
    pub mining_progress_ledger_enabled: bool,
    pub ranking_refresh_interval_ms: u64,
    pub ranking_redis_ttl_seconds: u64,
    pub job_timeout_public_ranking_ms: u64,
    pub ranking_loop_enabled: bool,
    pub my_rank_cache_ttl_ms: u64,
    /// Kill-switch Gerente accrual — mirror TS `isAccountManagerEnabled` (default off).
    pub account_manager_enabled: bool,
    /// Hourly gerente payout loop (owns Node `startGerentePayoutCron`).
    pub gerente_payout_loop_enabled: bool,
    pub gerente_payout_interval_ms: u64,
    pub job_timeout_gerente_payout_ms: u64,
    /// Chat TTL purge loop (owns Node `startChatTtlCron` SQL + disk).
    pub chat_ttl_loop_enabled: bool,
    pub chat_ttl_interval_ms: u64,
    pub job_timeout_chat_ttl_ms: u64,
    /// Idempotency purge loop (owns Node `startIdempotencyPurgeCron`).
    pub idempotency_purge_loop_enabled: bool,
    pub idempotency_purge_interval_ms: u64,
    pub job_timeout_idempotency_purge_ms: u64,
    /// Live-price sync loop (owns legacy `maybeSyncLiveUsdToMiningCoinsPostgres`).
    /// Gate: legacy `MINING_AUTO_SYNC_USD_PRICES=1` (default off).
    pub price_sync_loop_enabled: bool,
    pub price_sync_interval_ms: u64,
    pub job_timeout_price_sync_ms: u64,
    /// Legacy `MINING_COINGECKO_IDS_JSON` — `{ "<mining_coins.id>": "<coingecko-id>" }`.
    pub price_sync_coingecko_ids_json: Option<String>,
    /// Auto SQL backup loop (owns Node `startScheduledSqlBackups`).
    pub backup_sql_loop_enabled: bool,
    pub backup_disable_auto: bool,
    pub backup_auto_local_hour: u32,
    pub backup_auto_local_minute: u32,
    pub backup_sql_keep: u32,
    /// Age-based retention for auto dumps (days). Primary prune.
    pub backup_retention_days: u32,
    pub job_timeout_backup_sql_ms: u64,
    pub backup_dir: String,
    /// Google Drive off-site copy of every verified backup. All four required;
    /// module idles otherwise.
    pub gdrive_client_id: Option<String>,
    pub gdrive_client_secret: Option<String>,
    pub gdrive_refresh_token: Option<String>,
    pub gdrive_backup_folder_id: Option<String>,
    pub gdrive_retention_days: u32,
    /// Node `UPLOADS_DIR` (`bootstrap/deps.ts`) — runtime upload root.
    pub img_uploads_dir: String,
    /// Node `IMG_DIR` (`bootstrap/deps.ts`) — media-seed catalog root.
    pub img_dir: String,
    /// Node `createChatAudioMulter` dest — `CHAT_AUDIO_DIR` or `{uploads}/chat-audio`.
    pub chat_audio_dir: String,
    /// Node support multer dest — `SUPPORT_UPLOAD_DIR` or `{uploads}`.
    pub support_upload_dir: String,
    /// Node `createPartnerAvatarMulter` dest — `PARTNER_AVATAR_DIR` or `{uploads}/partner-avatars`.
    pub partner_avatar_dir: String,
    /// `GENESIS_AUTH_URL` — password hash/verify + refresh revoke. `None` = fail-closed 503.
    pub genesis_auth_url: Option<String>,
    /// Node `PARTNER_GAMES_MAINTENANCE` — `1`/`true` = hub in maintenance.
    pub partner_games_maintenance: bool,
    /// `ANTHROPIC_API_KEY` — calculator "Analisar com IA". `None` = `AI_NOT_CONFIGURED`.
    pub anthropic_api_key: Option<String>,
    /// `CALCULATOR_AI_MODEL` — Anthropic model id for the calculator analysis.
    pub calculator_ai_model: String,
}

impl WorkerConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = std::env::var("DATABASE_URL")
            .map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
        let redis_url = std::env::var("REDIS_URL")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let mining_worker_auth_token = resolve_mining_worker_auth_token()?;
        let img_uploads_dir = resolve_img_uploads_dir();
        let chat_audio_dir =
            resolve_subdir_or_join("CHAT_AUDIO_DIR", &img_uploads_dir, CHAT_AUDIO_SUBDIR);
        let support_upload_dir = resolve_subdir_or_join("SUPPORT_UPLOAD_DIR", &img_uploads_dir, "");
        let partner_avatar_dir = resolve_subdir_or_join(
            "PARTNER_AVATAR_DIR",
            &img_uploads_dir,
            PARTNER_AVATAR_SUBDIR,
        );

        Ok(Self {
            database_url,
            redis_url,
            yield_cron_interval_ms: resolve_yield_interval_ms(),
            startup_delay_ms: DEFAULT_STARTUP_DELAY_MS,
            scheduler_enabled: env_flag_default_on("SCHEDULER_ENABLED"),
            mining_yield_cron_enabled: env_flag_default_on("MINING_YIELD_CRON_ENABLED"),
            mining_yield_scheduler_enabled: env_flag_default_on("MINING_YIELD_SCHEDULER_ENABLED"),
            ten_minute_grid_enabled: mining_ten_minute_grid_enabled(),
            redis_locks_enabled: env_flag_default_on("GENESIS_REDIS_LOCKS_ENABLED"),
            job_timeout_mining_yield_ms: env_u64_clamped(
                "JOB_TIMEOUT_MINING_YIELD_MS",
                DEFAULT_JOB_TIMEOUT_MINING_YIELD_MS,
                MS_PER_SECOND,
                10 * MS_PER_MINUTE,
            ),
            kafka_enabled: env_flag_default_off("KAFKA_ENABLED"),
            kafka_brokers: std::env::var("KAFKA_BROKERS")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            kafka_client_id: std::env::var("KAFKA_CLIENT_ID")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            mining_worker_port: env_u16_clamped(
                "MINING_WORKER_PORT",
                MINING_WORKER_DEFAULT_PORT,
                1,
                u16::MAX,
            ),
            mining_worker_auth_token,
            mining_progress_lock_ttl_sec: env_u64_clamped(
                "MINING_PROGRESS_LOCK_TTL_SEC",
                LOCK_TTL_SEC_DEFAULT,
                LOCK_TTL_SEC_MIN,
                LOCK_TTL_SEC_MAX,
            ),
            mining_progress_compute_enabled: env_flag_default_on("MINING_PROGRESS_COMPUTE_ENABLED"),
            mining_progress_require_redis_lock: env_flag_default_off(
                "MINING_PROGRESS_REQUIRE_REDIS_LOCK",
            ),
            mining_progress_ledger_enabled: env_flag_default_on("MINING_PROGRESS_LEDGER_ENABLED"),
            ranking_refresh_interval_ms: resolve_ranking_refresh_interval_ms(),
            ranking_redis_ttl_seconds: {
                let interval = resolve_ranking_refresh_interval_ms();
                ((interval * RANKING_REDIS_TTL_SECONDS_MULTIPLIER) + MS_PER_SECOND - 1)
                    / MS_PER_SECOND
            },
            job_timeout_public_ranking_ms: env_u64_clamped(
                "JOB_TIMEOUT_PUBLIC_RANKING_MS",
                DEFAULT_JOB_TIMEOUT_PUBLIC_RANKING_MS,
                MS_PER_SECOND,
                10 * MS_PER_MINUTE,
            ),
            ranking_loop_enabled: env_flag_default_on("RANKING_REFRESH_LOOP_ENABLED"),
            my_rank_cache_ttl_ms: resolve_my_rank_cache_ttl_ms(),
            account_manager_enabled: account_manager_enabled_from_env(),
            gerente_payout_loop_enabled: env_flag_default_on("GERENTE_PAYOUT_LOOP_ENABLED"),
            gerente_payout_interval_ms: env_u64_clamped(
                "GERENTE_PAYOUT_INTERVAL_MS",
                DEFAULT_GERENTE_PAYOUT_INTERVAL_MS,
                MS_PER_MINUTE,
                24 * MS_PER_HOUR,
            ),
            job_timeout_gerente_payout_ms: env_u64_clamped(
                "JOB_TIMEOUT_GERENTE_PAYOUT_MS",
                DEFAULT_JOB_TIMEOUT_GERENTE_PAYOUT_MS,
                MS_PER_SECOND,
                10 * MS_PER_MINUTE,
            ),
            chat_ttl_loop_enabled: env_flag_default_on("CHAT_TTL_LOOP_ENABLED"),
            chat_ttl_interval_ms: env_u64_clamped(
                "CHAT_TTL_INTERVAL_MS",
                DEFAULT_CHAT_TTL_INTERVAL_MS,
                MS_PER_SECOND,
                MS_PER_HOUR,
            ),
            job_timeout_chat_ttl_ms: env_u64_clamped(
                "JOB_TIMEOUT_CHAT_TTL_MS",
                DEFAULT_JOB_TIMEOUT_CHAT_TTL_MS,
                MS_PER_SECOND,
                10 * MS_PER_MINUTE,
            ),
            idempotency_purge_loop_enabled: env_flag_default_on("IDEMPOTENCY_PURGE_LOOP_ENABLED"),
            idempotency_purge_interval_ms: env_u64_clamped(
                "IDEMPOTENCY_PURGE_INTERVAL_MS",
                DEFAULT_IDEMPOTENCY_PURGE_INTERVAL_MS,
                MS_PER_MINUTE,
                24 * MS_PER_HOUR,
            ),
            job_timeout_idempotency_purge_ms: env_u64_clamped(
                "JOB_TIMEOUT_IDEMPOTENCY_PURGE_MS",
                DEFAULT_JOB_TIMEOUT_IDEMPOTENCY_PURGE_MS,
                MS_PER_SECOND,
                10 * MS_PER_MINUTE,
            ),
            price_sync_loop_enabled: env_flag_default_off("MINING_AUTO_SYNC_USD_PRICES"),
            price_sync_interval_ms: env_u64_clamped(
                "MINING_PRICE_DB_SYNC_INTERVAL_MS",
                DEFAULT_PRICE_SYNC_INTERVAL_MS,
                MS_PER_MINUTE,
                24 * MS_PER_HOUR,
            ),
            job_timeout_price_sync_ms: env_u64_clamped(
                "JOB_TIMEOUT_PRICE_SYNC_MS",
                DEFAULT_JOB_TIMEOUT_PRICE_SYNC_MS,
                MS_PER_SECOND,
                5 * MS_PER_MINUTE,
            ),
            price_sync_coingecko_ids_json: std::env::var("MINING_COINGECKO_IDS_JSON")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            backup_sql_loop_enabled: env_flag_default_on("BACKUP_SQL_LOOP_ENABLED"),
            backup_disable_auto: backup_disable_auto_from_env(),
            backup_auto_local_hour: env_u32_clamped(
                "BACKUP_AUTO_LOCAL_HOUR",
                0,
                0,
                BACKUP_AUTO_HOUR_MAX,
            ),
            backup_auto_local_minute: env_u32_clamped(
                "BACKUP_AUTO_LOCAL_MINUTE",
                0,
                0,
                BACKUP_AUTO_MINUTE_MAX,
            ),
            backup_sql_keep: resolve_backup_sql_keep(),
            backup_retention_days: env_u32_clamped(
                "BACKUP_RETENTION_DAYS",
                DEFAULT_BACKUP_RETENTION_DAYS,
                BACKUP_RETENTION_DAYS_MIN,
                BACKUP_RETENTION_DAYS_MAX,
            ),
            job_timeout_backup_sql_ms: env_u64_clamped(
                "JOB_TIMEOUT_BACKUP_SQL_MS",
                DEFAULT_JOB_TIMEOUT_BACKUP_SQL_MS,
                MS_PER_SECOND,
                JOB_TIMEOUT_BACKUP_SQL_MAX_MS,
            ),
            backup_dir: resolve_backup_dir(),
            gdrive_client_id: env_opt("GDRIVE_CLIENT_ID"),
            gdrive_client_secret: env_opt("GDRIVE_CLIENT_SECRET"),
            gdrive_refresh_token: env_opt("GDRIVE_REFRESH_TOKEN"),
            gdrive_backup_folder_id: env_opt("GDRIVE_BACKUP_FOLDER_ID"),
            gdrive_retention_days: env_u32_clamped(
                "GDRIVE_RETENTION_DAYS",
                env_u32_clamped(
                    "BACKUP_RETENTION_DAYS",
                    DEFAULT_BACKUP_RETENTION_DAYS,
                    BACKUP_RETENTION_DAYS_MIN,
                    BACKUP_RETENTION_DAYS_MAX,
                ),
                BACKUP_RETENTION_DAYS_MIN,
                BACKUP_RETENTION_DAYS_MAX,
            ),
            img_uploads_dir,
            img_dir: resolve_img_dir(),
            chat_audio_dir,
            support_upload_dir,
            partner_avatar_dir,
            genesis_auth_url: std::env::var("GENESIS_AUTH_URL")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            partner_games_maintenance: partner_games_maintenance_from_env(),
            anthropic_api_key: std::env::var("ANTHROPIC_API_KEY")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            calculator_ai_model: std::env::var("CALCULATOR_AI_MODEL")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "claude-sonnet-5".to_string()),
        })
    }

    pub fn yield_loop_enabled(&self) -> bool {
        self.scheduler_enabled
            && self.mining_yield_cron_enabled
            && self.mining_yield_scheduler_enabled
    }

    pub fn ranking_loop_active(&self) -> bool {
        self.scheduler_enabled && self.ranking_loop_enabled
    }

    pub fn gerente_payout_loop_active(&self) -> bool {
        self.scheduler_enabled && self.gerente_payout_loop_enabled
    }

    pub fn chat_ttl_loop_active(&self) -> bool {
        self.scheduler_enabled && self.chat_ttl_loop_enabled
    }

    pub fn idempotency_purge_loop_active(&self) -> bool {
        self.scheduler_enabled && self.idempotency_purge_loop_enabled
    }

    pub fn price_sync_loop_active(&self) -> bool {
        self.scheduler_enabled && self.price_sync_loop_enabled
    }

    pub fn backup_sql_loop_active(&self) -> bool {
        self.scheduler_enabled && self.backup_sql_loop_enabled && !self.backup_disable_auto
    }

    /// Google Drive off-site copy is configured (all four secrets present).
    pub fn gdrive_active(&self) -> bool {
        self.gdrive_client_id.is_some()
            && self.gdrive_client_secret.is_some()
            && self.gdrive_refresh_token.is_some()
            && self.gdrive_backup_folder_id.is_some()
    }
}

/// Trimmed env var, `None` when unset or blank.
fn env_opt(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `MINING_WORKER_AUTH_TOKEN`: required when `NODE_ENV=production`; optional in dev
/// (empty → auth off, caller should log warn once at startup).
fn resolve_mining_worker_auth_token() -> anyhow::Result<Option<String>> {
    let token = std::env::var("MINING_WORKER_AUTH_TOKEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let is_prod = std::env::var("NODE_ENV")
        .map(|v| v.trim().eq_ignore_ascii_case("production"))
        .unwrap_or(false);
    if is_prod && token.is_none() {
        anyhow::bail!("MINING_WORKER_AUTH_TOKEN is required when NODE_ENV=production");
    }
    Ok(token)
}

/// Node `BACKUP_DISABLE_AUTO === '1' || toLowerCase() === 'true'`.
fn backup_disable_auto_from_env() -> bool {
    match std::env::var("BACKUP_DISABLE_AUTO") {
        Ok(v) => {
            let t = v.trim();
            t == "1" || t.eq_ignore_ascii_case("true")
        }
        Err(_) => false,
    }
}

fn resolve_backup_dir() -> String {
    std::env::var("BACKUP_DIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_BACKUP_DIR.to_string())
}

/// Node `BACKUP_SQL_KEEP` clamped to `AUTO_BACKUP_KEEP_MIN`..=`AUTO_BACKUP_KEEP_MAX`.
fn resolve_backup_sql_keep() -> u32 {
    env_u32_clamped(
        "BACKUP_SQL_KEEP",
        DEFAULT_BACKUP_SQL_KEEP,
        AUTO_BACKUP_KEEP_MIN,
        AUTO_BACKUP_KEEP_MAX,
    )
}

fn env_u32_clamped(key: &str, fallback: u32, min: u32, max: u32) -> u32 {
    match std::env::var(key) {
        Ok(raw) => match raw.trim().parse::<u32>() {
            Ok(n) => n.clamp(min, max),
            Err(_) => fallback,
        },
        Err(_) => fallback,
    }
}

fn env_flag_default_on(key: &str) -> bool {
    match std::env::var(key) {
        Ok(v) => {
            let t = v.trim();
            t != "0" && !t.eq_ignore_ascii_case("false") && !t.eq_ignore_ascii_case("off")
        }
        Err(_) => true,
    }
}

fn env_flag_default_off(key: &str) -> bool {
    match std::env::var(key) {
        Ok(v) => {
            let t = v.trim();
            t == "1" || t.eq_ignore_ascii_case("true") || t.eq_ignore_ascii_case("on")
        }
        Err(_) => false,
    }
}

/// Mirror `server/modules/gerente/services/feature.ts` — accepts `yes` (unlike `env_flag_default_off`).
fn account_manager_enabled_from_env() -> bool {
    match std::env::var("ACCOUNT_MANAGER_ENABLED") {
        Ok(v) => {
            let t = v.trim().to_ascii_lowercase();
            t == "1" || t == "true" || t == "yes" || t == "on"
        }
        Err(_) => false,
    }
}

/// Node `partnerGamesMaintenanceEnabled` — `1` / `true` only.
fn partner_games_maintenance_from_env() -> bool {
    match std::env::var("PARTNER_GAMES_MAINTENANCE") {
        Ok(v) => {
            let t = v.trim().to_ascii_lowercase();
            t == "1" || t == "true"
        }
        Err(_) => false,
    }
}

fn mining_ten_minute_grid_enabled() -> bool {
    match std::env::var("MINING_WALL_CLOCK_TEN_MIN_GRID") {
        Ok(v) => {
            let t = v.trim().to_ascii_lowercase();
            t != "0" && t != "false" && t != "off"
        }
        Err(_) => true,
    }
}

fn resolve_yield_interval_ms() -> u64 {
    match std::env::var("MINING_YIELD_CRON_INTERVAL_MS") {
        Ok(raw) => match raw.trim().parse::<u64>() {
            Ok(ms) if ms >= MIN_YIELD_CRON_INTERVAL_MS => ms,
            _ => DEFAULT_YIELD_CRON_INTERVAL_MS,
        },
        Err(_) => DEFAULT_YIELD_CRON_INTERVAL_MS,
    }
}

fn resolve_ranking_refresh_interval_ms() -> u64 {
    match std::env::var("RANKING_REFRESH_INTERVAL_MS") {
        Ok(raw) => match raw.trim().parse::<u64>() {
            Ok(ms) if ms > 0 => ms,
            _ => DEFAULT_RANKING_REFRESH_INTERVAL_MS,
        },
        Err(_) => DEFAULT_RANKING_REFRESH_INTERVAL_MS,
    }
}

fn resolve_my_rank_cache_ttl_ms() -> u64 {
    let parsed = match std::env::var("MY_RANK_CACHE_TTL_MS") {
        Ok(raw) => raw.trim().parse::<u64>().ok(),
        Err(_) => None,
    };
    let base = parsed.unwrap_or(MY_RANK_CACHE_TTL_DEFAULT_MS);
    base.clamp(MY_RANK_CACHE_TTL_FLOOR_MS, MY_RANK_CACHE_TTL_CEILING_MS)
}

fn env_u64_clamped(key: &str, fallback: u64, min: u64, max: u64) -> u64 {
    match std::env::var(key) {
        Ok(raw) => match raw.trim().parse::<u64>() {
            Ok(n) => n.clamp(min, max),
            Err(_) => fallback,
        },
        Err(_) => fallback,
    }
}

/// Node `bootstrap/deps.ts` `UPLOADS_DIR` default.
const DEFAULT_IMG_UPLOADS_DIR: &str = "storage/uploads";
/// Node `bootstrap/deps.ts` `IMG_DIR` default (same as genesis-api).
const DEFAULT_IMG_DIR: &str = "storage/media-seed";
/// Node `createChatAudioMulter` subdirectory.
const CHAT_AUDIO_SUBDIR: &str = "chat-audio";
/// Node `createPartnerAvatarMulter` subdirectory.
const PARTNER_AVATAR_SUBDIR: &str = "partner-avatars";

fn resolve_img_uploads_dir() -> String {
    std::env::var("IMG_UPLOADS_DIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_IMG_UPLOADS_DIR.to_string())
}

fn resolve_img_dir() -> String {
    std::env::var("IMG_DIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_IMG_DIR.to_string())
}

fn resolve_subdir_or_join(env_key: &str, uploads_dir: &str, subdir: &str) -> String {
    if let Some(raw) = std::env::var(env_key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return raw;
    }
    if subdir.is_empty() {
        return uploads_dir.to_string();
    }
    format!("{uploads_dir}/{subdir}")
}

fn env_u16_clamped(key: &str, fallback: u16, min: u16, max: u16) -> u16 {
    match std::env::var(key) {
        Ok(raw) => match raw.trim().parse::<u16>() {
            Ok(n) => n.clamp(min, max),
            Err(_) => fallback,
        },
        Err(_) => fallback,
    }
}
