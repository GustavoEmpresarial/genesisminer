//! Grelha UTC de 10 minutos — espelho de `wall-clock-grid.ts`.

use crate::checkin::utc_checkin_period_start_ms;
use crate::time::MS_PER_MINUTE;

/// Duração da grelha canónica UTC (≠ `mining_coins.block_time`).
pub const TEN_MIN_MS: i64 = (10 * MS_PER_MINUTE) as i64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditHistoryWindow {
    pub start_ms: i64,
    pub end_ms: i64,
}

/// Meia-noite UTC do dia civil que contém `ts` (igual a `Date.UTC(y,m,d,0,0,0)`).
pub fn utc_midnight_ms(ts: i64) -> i64 {
    utc_checkin_period_start_ms(ts)
}

/// Maior instante T ≤ ts na grelha 10 min UTC.
pub fn last_completed_ten_minute_utc_grid(ts: i64) -> i64 {
    let day0 = utc_midnight_ms(ts);
    let rel = ts - day0;
    if rel < 0 {
        return day0;
    }
    day0 + (rel / TEN_MIN_MS) * TEN_MIN_MS
}

/// Tecto de crédito: último boundary completo, ou `now_ms` se grelha desligada.
pub fn mining_credit_cap_now_ms(now_ms: i64, grid_enabled: bool) -> i64 {
    if !grid_enabled {
        return now_ms;
    }
    last_completed_ten_minute_utc_grid(now_ms)
}

/// Boundaries de yield ainda não persistidos, ordem crescente.
pub fn list_pending_ten_minute_boundaries(checkpoint_ms: f64, cap_ms: f64) -> Vec<i64> {
    if !cap_ms.is_finite() || !(cap_ms > 0.0) {
        return Vec::new();
    }
    let cap = last_completed_ten_minute_utc_grid(cap_ms as i64);
    if !(cap > 0) {
        return Vec::new();
    }
    if !checkpoint_ms.is_finite() || !(checkpoint_ms > 0.0) {
        return vec![cap];
    }
    let checkpoint = last_completed_ten_minute_utc_grid(checkpoint_ms as i64);
    if !(cap > checkpoint) {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut b = checkpoint + TEN_MIN_MS;
    while b <= cap {
        out.push(b);
        b += TEN_MIN_MS;
    }
    out
}

/// Particiona `[start_ms, end_ms)` em segmentos alinhados à grelha (parciais off-grid OK).
pub fn list_credit_history_windows(start_ms: f64, end_ms: f64) -> Vec<CreditHistoryWindow> {
    if !(start_ms.is_finite() && end_ms.is_finite()) || !(end_ms > start_ms) {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cursor = start_ms as i64;
    let end = end_ms as i64;
    while cursor < end {
        let day0 = utc_midnight_ms(cursor);
        let steps = {
            let num = cursor - day0;
            // ceil(num / TEN_MIN_MS) for integers
            if num <= 0 {
                0
            } else {
                (num + TEN_MIN_MS - 1) / TEN_MIN_MS
            }
        };
        let mut next_boundary = day0 + steps * TEN_MIN_MS;
        if next_boundary <= cursor {
            next_boundary = cursor + TEN_MIN_MS;
        }
        let segment_end = next_boundary.min(end);
        if !(segment_end > cursor) {
            break;
        }
        out.push(CreditHistoryWindow {
            start_ms: cursor,
            end_ms: segment_end,
        });
        cursor = segment_end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day0() -> i64 {
        crate::checkin::utc_day_start_ms("2026-08-20").expect("ymd")
    }

    #[test]
    fn pending_normal_and_catchup() {
        let d0 = day0();
        let t2220 = d0 + 22 * 60 * 60 * 1000 + 20 * 60 * 1000;
        let t2230 = t2220 + TEN_MIN_MS;
        let t2240 = t2230 + TEN_MIN_MS;
        let t2250 = t2240 + TEN_MIN_MS;
        assert_eq!(
            list_pending_ten_minute_boundaries(t2220 as f64, (t2230 + 5_000) as f64),
            vec![t2230]
        );
        assert_eq!(
            list_pending_ten_minute_boundaries(t2220 as f64, (t2250 + 3 * 60_000) as f64),
            vec![t2230, t2240, t2250]
        );
        assert!(list_pending_ten_minute_boundaries(t2250 as f64, t2250 as f64).is_empty());
        assert_eq!(
            list_pending_ten_minute_boundaries(0.0, (t2250 + 1) as f64),
            vec![t2250]
        );
    }

    #[test]
    fn credit_windows() {
        let d0 = day0();
        let t2220 = d0 + 22 * 60 * 60 * 1000 + 20 * 60 * 1000;
        let t2230 = t2220 + TEN_MIN_MS;
        let t2240 = t2230 + TEN_MIN_MS;
        let t2250 = t2240 + TEN_MIN_MS;
        assert_eq!(
            list_credit_history_windows(t2220 as f64, t2230 as f64),
            vec![CreditHistoryWindow {
                start_ms: t2220,
                end_ms: t2230
            }]
        );
        let t2225 = t2220 + 5 * 60_000;
        assert_eq!(
            list_credit_history_windows(t2225 as f64, t2250 as f64),
            vec![
                CreditHistoryWindow {
                    start_ms: t2225,
                    end_ms: t2230
                },
                CreditHistoryWindow {
                    start_ms: t2230,
                    end_ms: t2240
                },
                CreditHistoryWindow {
                    start_ms: t2240,
                    end_ms: t2250
                },
            ]
        );
    }
}
