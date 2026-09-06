//! Portal de transparência — saúde do projecto a partir das publicações.
//! Espelha `client/src/features/transparency/lib/health.ts`.

mod health;

pub use health::{
    clamp_health, compute_transparency_health, health_band, is_same_zoned_day,
    normalize_health_category, score_inflow, score_published_ledger, score_rent, HealthBand,
    PlayerCashFlows, TransparencyHealthCategory, TransparencyHealthEntry,
    TransparencyHealthSnapshot, HEALTH_WEIGHT_INFLOW, HEALTH_WEIGHT_LEDGER, HEALTH_WEIGHT_RENT,
    TRANSPARENCY_HEALTH_CEILING, TRANSPARENCY_HEALTH_FLOOR, TRANSPARENCY_HEALTH_TZ,
};
