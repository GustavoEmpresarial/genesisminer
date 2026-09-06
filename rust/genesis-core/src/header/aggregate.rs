//! Aggregate effective H/s for the game header strip.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One credit after check-in bonus (if applicable).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderHashEntry {
    pub coin_id: String,
    pub effective_hps: f64,
    pub counts_toward_general_power: bool,
}

/// Aggregated header hash fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderHashAggregate {
    pub hash_by_coin_id: HashMap<String, f64>,
    pub total_hash: f64,
}

/// Sum per-coin H/s for all entries; `total_hash` only from general-power credits.
pub fn aggregate_header_hash(entries: &[HeaderHashEntry]) -> HeaderHashAggregate {
    let mut hash_by_coin_id: HashMap<String, f64> = HashMap::new();
    let mut total_hash = 0.0;
    for e in entries {
        if !e.effective_hps.is_finite() || e.effective_hps <= 0.0 {
            continue;
        }
        *hash_by_coin_id.entry(e.coin_id.clone()).or_insert(0.0) += e.effective_hps;
        if e.counts_toward_general_power {
            total_hash += e.effective_hps;
        }
    }
    HeaderHashAggregate {
        hash_by_coin_id,
        total_hash,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_includes_all_coins_total_only_general() {
        let entries = vec![
            HeaderHashEntry {
                coin_id: "btc".into(),
                effective_hps: 10.0,
                counts_toward_general_power: true,
            },
            HeaderHashEntry {
                coin_id: "usdt".into(),
                effective_hps: 50.0,
                counts_toward_general_power: false,
            },
            HeaderHashEntry {
                coin_id: "btc".into(),
                effective_hps: 5.0,
                counts_toward_general_power: true,
            },
        ];
        let out = aggregate_header_hash(&entries);
        assert_eq!(out.hash_by_coin_id.get("btc").copied().unwrap_or(0.0), 15.0);
        assert_eq!(
            out.hash_by_coin_id.get("usdt").copied().unwrap_or(0.0),
            50.0
        );
        assert_eq!(out.total_hash, 15.0);
    }

    #[test]
    fn aggregate_skips_non_positive_or_nan() {
        let entries = vec![
            HeaderHashEntry {
                coin_id: "btc".into(),
                effective_hps: 0.0,
                counts_toward_general_power: true,
            },
            HeaderHashEntry {
                coin_id: "eth".into(),
                effective_hps: f64::NAN,
                counts_toward_general_power: true,
            },
            HeaderHashEntry {
                coin_id: "ltc".into(),
                effective_hps: -1.0,
                counts_toward_general_power: true,
            },
            HeaderHashEntry {
                coin_id: "doge".into(),
                effective_hps: 3.0,
                counts_toward_general_power: false,
            },
        ];
        let out = aggregate_header_hash(&entries);
        assert!(out.hash_by_coin_id.get("btc").is_none());
        assert!(out.hash_by_coin_id.get("eth").is_none());
        assert!(out.hash_by_coin_id.get("ltc").is_none());
        assert_eq!(out.hash_by_coin_id.get("doge").copied().unwrap_or(0.0), 3.0);
        assert_eq!(out.total_hash, 0.0);
    }
}
