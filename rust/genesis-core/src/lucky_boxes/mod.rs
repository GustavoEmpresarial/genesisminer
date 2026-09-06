//! Lucky-box / loot roll helpers — independent + grant-all.
//! Samples are provided by the host (Node `Math.random`); no RNG inside.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROBABILITY_MAX: f64 = 100.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LootBoxItem {
    pub item_type: String,
    pub item_id: String,
    pub min_qty: f64,
    pub max_qty: f64,
    pub probability: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LootRewardGrant {
    #[serde(rename = "type")]
    pub reward_type: String,
    pub id: String,
    pub qty: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RolledLootPayload {
    pub rewards: Vec<LootRewardGrant>,
    pub gained_usdc: f64,
    pub gained_items: BTreeMap<String, f64>,
    pub gained_coins: BTreeMap<String, f64>,
    pub gained_bundles: Vec<BundleGrant>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleGrant {
    pub id: String,
    pub qty: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RollError {
    InsufficientSamples { need: usize, got: usize },
}

impl std::fmt::Display for RollError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InsufficientSamples { need, got } => {
                write!(f, "insufficient samples: need {need}, got {got}")
            }
        }
    }
}

fn empty_payload() -> RolledLootPayload {
    RolledLootPayload {
        rewards: Vec::new(),
        gained_usdc: 0.0,
        gained_items: BTreeMap::new(),
        gained_coins: BTreeMap::new(),
        gained_bundles: Vec::new(),
    }
}

fn probability_of(it: &LootBoxItem) -> f64 {
    let p = if it.probability.is_finite() {
        it.probability
    } else {
        0.0
    };
    p.max(0.0)
}

fn clamped_prob(it: &LootBoxItem) -> f64 {
    probability_of(it).min(PROBABILITY_MAX)
}

fn eligible_items(items: &[LootBoxItem]) -> Vec<&LootBoxItem> {
    items.iter().filter(|it| probability_of(it) > 0.0).collect()
}

/// Qty in `[minQ, maxQ]` from sample in `[0, 1)`.
fn qty_from_sample(it: &LootBoxItem, sample: f64) -> f64 {
    let min_q = if it.min_qty.is_finite() {
        it.min_qty.max(0.0)
    } else {
        0.0
    };
    let max_raw = if it.max_qty.is_finite() {
        it.max_qty
    } else {
        min_q
    };
    let max_q = max_raw.max(min_q);
    let span = max_q - min_q + 1.0;
    let s = if sample.is_finite() && sample >= 0.0 && sample < 1.0 {
        sample
    } else {
        0.0
    };
    (s * span).floor() + min_q
}

fn append_grant(payload: &mut RolledLootPayload, chosen: &LootBoxItem, qty: f64) {
    let item_type = if chosen.item_type.is_empty() {
        "item"
    } else {
        chosen.item_type.as_str()
    };
    let item_id = chosen.item_id.as_str();

    match item_type {
        "currency" => {
            if item_id == "usdc" {
                payload.gained_usdc += qty;
            }
            payload.rewards.push(LootRewardGrant {
                reward_type: "currency".into(),
                id: item_id.into(),
                qty,
            });
        }
        "coin" => {
            *payload.gained_coins.entry(item_id.into()).or_insert(0.0) += qty;
            payload.rewards.push(LootRewardGrant {
                reward_type: "coin".into(),
                id: item_id.into(),
                qty,
            });
        }
        "bundle" => {
            payload.gained_bundles.push(BundleGrant {
                id: item_id.into(),
                qty,
            });
            payload.rewards.push(LootRewardGrant {
                reward_type: "bundle".into(),
                id: item_id.into(),
                qty,
            });
        }
        _ => {
            *payload.gained_items.entry(item_id.into()).or_insert(0.0) += qty;
            payload.rewards.push(LootRewardGrant {
                reward_type: "item".into(),
                id: item_id.into(),
                qty,
            });
        }
    }
}

struct SampleCursor<'a> {
    samples: &'a [f64],
    idx: usize,
}

impl<'a> SampleCursor<'a> {
    fn next(&mut self) -> Result<f64, RollError> {
        if self.idx >= self.samples.len() {
            return Err(RollError::InsufficientSamples {
                need: self.idx + 1,
                got: self.samples.len(),
            });
        }
        let v = self.samples[self.idx];
        self.idx += 1;
        Ok(v)
    }
}

/// Independent roll: one hit-test sample per eligible item; qty sample per won line.
/// If none win, fallback to highest-probability eligible (still needs a qty sample).
pub fn roll_independent(
    items: &[LootBoxItem],
    rng: &[f64],
) -> Result<RolledLootPayload, RollError> {
    let eligible = eligible_items(items);
    if eligible.is_empty() {
        return Ok(empty_payload());
    }

    let mut cursor = SampleCursor {
        samples: rng,
        idx: 0,
    };
    let mut won: Vec<&LootBoxItem> = Vec::new();
    for it in &eligible {
        let sample = cursor.next()?;
        let prob = clamped_prob(it);
        if sample * PROBABILITY_MAX < prob {
            won.push(it);
        }
    }

    if won.is_empty() {
        let best = eligible
            .iter()
            .copied()
            .max_by(|a, b| {
                probability_of(a)
                    .partial_cmp(&probability_of(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .expect("eligible non-empty");
        won.push(best);
    }

    let mut payload = empty_payload();
    for it in won {
        let sample = cursor.next()?;
        let qty = qty_from_sample(it, sample);
        append_grant(&mut payload, it, qty);
    }
    Ok(payload)
}

/// Grant-all: every eligible line once; one qty sample each.
pub fn roll_grant_all(items: &[LootBoxItem], rng: &[f64]) -> Result<RolledLootPayload, RollError> {
    let eligible = eligible_items(items);
    let mut cursor = SampleCursor {
        samples: rng,
        idx: 0,
    };
    let mut payload = empty_payload();
    for it in eligible {
        let sample = cursor.next()?;
        let qty = qty_from_sample(it, sample);
        append_grant(&mut payload, it, qty);
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(ty: &str, id: &str, min_q: f64, max_q: f64, prob: f64) -> LootBoxItem {
        LootBoxItem {
            item_type: ty.into(),
            item_id: id.into(),
            min_qty: min_q,
            max_qty: max_q,
            probability: prob,
        }
    }

    #[test]
    fn independent_always_hit_prob_100() {
        let items = vec![item("item", "gpu_1", 1.0, 1.0, 100.0)];
        // hit sample 0.5 → 50 < 100; qty sample unused span → qty 1
        let out = roll_independent(&items, &[0.5, 0.0]).unwrap();
        assert_eq!(out.rewards.len(), 1);
        assert_eq!(out.rewards[0].id, "gpu_1");
        assert_eq!(out.rewards[0].qty, 1.0);
        assert_eq!(out.gained_items.get("gpu_1"), Some(&1.0));
    }

    #[test]
    fn independent_miss_then_fallback() {
        let items = vec![
            item("item", "a", 1.0, 1.0, 10.0),
            item("item", "b", 2.0, 2.0, 50.0),
        ];
        // both miss (0.99 * 100 = 99 >= 10 and >= 50), fallback to b (higher prob)
        let out = roll_independent(&items, &[0.99, 0.99, 0.0]).unwrap();
        assert_eq!(out.rewards.len(), 1);
        assert_eq!(out.rewards[0].id, "b");
        assert_eq!(out.rewards[0].qty, 2.0);
    }

    #[test]
    fn independent_insufficient_samples_err() {
        let items = vec![item("item", "a", 1.0, 1.0, 100.0)];
        let err = roll_independent(&items, &[0.1]).unwrap_err();
        assert!(matches!(err, RollError::InsufficientSamples { .. }));
    }

    #[test]
    fn grant_all_delivers_all_eligible() {
        let items = vec![
            item("currency", "usdc", 5.0, 5.0, 100.0),
            item("coin", "btc", 1.0, 1.0, 50.0),
            item("item", "x", 1.0, 1.0, 0.0), // skipped
        ];
        let out = roll_grant_all(&items, &[0.0, 0.0]).unwrap();
        assert_eq!(out.gained_usdc, 5.0);
        assert_eq!(out.gained_coins.get("btc"), Some(&1.0));
        assert!(out.gained_items.is_empty());
        assert_eq!(out.rewards.len(), 2);
    }

    #[test]
    fn qty_span_uses_floor() {
        // min=1 max=3 → span=3; sample 0.999 → floor(2.997)+1 = 3
        let items = vec![item("item", "q", 1.0, 3.0, 100.0)];
        let out = roll_independent(&items, &[0.0, 0.999]).unwrap();
        assert_eq!(out.rewards[0].qty, 3.0);
        // sample 0.0 → floor(0)+1 = 1
        let out2 = roll_independent(&items, &[0.0, 0.0]).unwrap();
        assert_eq!(out2.rewards[0].qty, 1.0);
    }

    #[test]
    fn empty_items_ok() {
        let out = roll_independent(&[], &[]).unwrap();
        assert!(out.rewards.is_empty());
        let out2 = roll_grant_all(&[], &[]).unwrap();
        assert!(out2.rewards.is_empty());
    }
}
