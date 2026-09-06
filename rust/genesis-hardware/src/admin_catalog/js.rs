//! JavaScript coercion parity for the admin catalog writes.
//!
//! The Node services these twins replace lean on JS operators (`Number(x) || 0`,
//! `parseFloat(String(x ?? ''))`, `x ? 1 : 0`, `x ?? null`) and the admin panel
//! already posts payloads that depend on the exact edge cases: `"0"` is truthy,
//! `null` numbers to `0`, absent keys number to `NaN`, `parseFloat` reads a
//! numeric prefix. Same contract as `genesis-mining-worker`'s `settings_writes::js`.

use serde_json::Value;

/// Node `round8` in `catalog/services/mining-coins.ts` (`Math.round(n * 1e8) / 1e8`).
const ROUND8_SCALE: f64 = 1e8;

/// JS `!!value` (`undefined`/absent → `false`).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// JS `String(value)` for the scalars the admin forms send.
pub fn string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|i| match i {
                Value::Null => String::new(),
                other => string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// JS `String(value || fallback)` — falsy input yields the fallback.
pub fn string_or(v: Option<&Value>, fallback: &str) -> String {
    if truthy(v) {
        string(v)
    } else {
        fallback.to_string()
    }
}

/// JS `String(value ?? fallback)` — only `null`/absent yield the fallback.
pub fn string_or_nullish(v: Option<&Value>, fallback: &str) -> String {
    match v {
        None | Some(Value::Null) => fallback.to_string(),
        other => string(other),
    }
}

/// JS `value ?? null` as a Postgres text parameter.
pub fn nullish_string(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        other => Some(string(other)),
    }
}

/// JS `value ?? null` as a Postgres double parameter (numeric strings included,
/// like the implicit cast `node-postgres` gets from a text parameter).
pub fn nullish_number(v: Option<&Value>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// JS `Number(value)` — absent/objects → `NaN`, `null` → `0`, arrays via their
/// string form (`[] → 0`, `[5] → 5`, `[1,2] → NaN`).
pub fn number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => number_from_str(s),
        Some(Value::Array(items)) => {
            let joined = items
                .iter()
                .map(|i| match i {
                    Value::Null => String::new(),
                    other => string(Some(other)),
                })
                .collect::<Vec<_>>()
                .join(",");
            number_from_str(&joined)
        }
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// JS `Number(value) || 0` — `NaN`/`0`/`-0` all collapse to `0`.
pub fn number_or_zero(v: Option<&Value>) -> f64 {
    let n = number(v);
    if n.is_nan() || n == 0.0 {
        0.0
    } else {
        n
    }
}

/// JS `parseFloat(String(value ?? ''))` — the coercion every `mining_coins`
/// numeric field goes through.
pub fn parse_float_field(v: Option<&Value>) -> f64 {
    parse_float(&string_or_nullish(v, ""))
}

/// JS `parseFloat` — longest numeric prefix, `NaN` when there is none.
pub fn parse_float(raw: &str) -> f64 {
    let s = raw.trim_start();
    let bytes = s.as_bytes();
    let mut i = 0;
    let negative = bytes.first() == Some(&b'-');
    if matches!(bytes.first(), Some(b'+') | Some(b'-')) {
        i += 1;
    }
    if s[i..].starts_with("Infinity") {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let mantissa_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let had_int_digits = i > mantissa_start;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if !had_int_digits && i == frac_start {
            return f64::NAN;
        }
    } else if !had_int_digits {
        return f64::NAN;
    }
    let mantissa_end = i;
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if matches!(bytes.get(j), Some(b'+') | Some(b'-')) {
            j += 1;
        }
        let exp_start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        i = if j > exp_start { j } else { mantissa_end };
    }
    s[..i].parse::<f64>().unwrap_or(f64::NAN)
}

/// JS `Math.round` — halves go up (towards `+Infinity`), unlike Rust's
/// round-half-away-from-zero.
pub fn math_round(n: f64) -> f64 {
    if !n.is_finite() {
        return n;
    }
    (n + 0.5).floor()
}

/// Node `round8` — non-finite input collapses to `0`.
pub fn round8(n: f64) -> f64 {
    if !n.is_finite() {
        return 0.0;
    }
    math_round(n * ROUND8_SCALE) / ROUND8_SCALE
}

/// JS `String(value)` for a number; `Infinity`/`NaN` keep their JS spelling so
/// the stored KV string stays readable by both runtimes.
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n.is_sign_negative() {
            "-Infinity".into()
        } else {
            "Infinity".into()
        };
    }
    format!("{n}")
}

fn number_from_str(raw: &str) -> f64 {
    let t = raw.trim();
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => t.parse::<f64>().unwrap_or(f64::NAN),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truthiness_matches_node() {
        assert!(!truthy(None));
        assert!(!truthy(Some(&json!(null))));
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(""))));
        // `"0"` and `[]` are truthy in JS — the admin panel relies on it.
        assert!(truthy(Some(&json!("0"))));
        assert!(truthy(Some(&json!([]))));
        assert!(truthy(Some(&json!({}))));
    }

    #[test]
    fn number_matches_node() {
        assert!(number(None).is_nan());
        assert_eq!(number(Some(&json!(null))), 0.0);
        assert_eq!(number(Some(&json!("  12.5 "))), 12.5);
        assert!(number(Some(&json!("abc"))).is_nan());
        assert_eq!(number(Some(&json!([5]))), 5.0);
        assert_eq!(number_or_zero(Some(&json!("abc"))), 0.0);
    }

    #[test]
    fn parse_float_reads_numeric_prefix() {
        assert_eq!(parse_float("12px"), 12.0);
        assert_eq!(parse_float("  3.5e2xyz"), 350.0);
        assert_eq!(parse_float(".5"), 0.5);
        assert_eq!(parse_float("-2"), -2.0);
        assert_eq!(parse_float("1e"), 1.0);
        assert!(parse_float("").is_nan());
        assert!(parse_float(".").is_nan());
        assert!(parse_float("abc").is_nan());
        assert_eq!(parse_float("Infinity"), f64::INFINITY);
        assert_eq!(parse_float("-Infinity"), f64::NEG_INFINITY);
    }

    #[test]
    fn parse_float_field_uses_nullish_string() {
        assert!(parse_float_field(None).is_nan());
        assert!(parse_float_field(Some(&json!(null))).is_nan());
        assert_eq!(parse_float_field(Some(&json!(7))), 7.0);
        assert_eq!(parse_float_field(Some(&json!("7.25"))), 7.25);
    }

    #[test]
    fn round8_and_math_round_match_node() {
        assert_eq!(round8(1.234_567_891), 1.234_567_89);
        assert_eq!(round8(f64::NAN), 0.0);
        assert_eq!(round8(f64::INFINITY), 0.0);
        // JS `Math.round(-0.5) === -0`, i.e. halves go up, not away from zero.
        assert_eq!(math_round(-0.5), 0.0);
        assert_eq!(math_round(0.5), 1.0);
        assert_eq!(math_round(2.5), 3.0);
    }

    #[test]
    fn string_helpers_match_node() {
        assert_eq!(string(Some(&json!(7))), "7");
        assert_eq!(string(Some(&json!(true))), "true");
        assert_eq!(string_or(Some(&json!("")), "shop"), "shop");
        assert_eq!(string_or(Some(&json!("special")), "shop"), "special");
        // `?? ''` keeps the empty string; `|| ''` would not.
        assert_eq!(string_or_nullish(Some(&json!("")), "x"), "");
        assert_eq!(string_or_nullish(Some(&json!(null)), "x"), "x");
        assert_eq!(nullish_string(Some(&json!(null))), None);
        assert_eq!(nullish_string(Some(&json!("a"))), Some("a".into()));
        assert_eq!(nullish_number(Some(&json!("1.5"))), Some(1.5));
        assert_eq!(nullish_number(None), None);
    }

    #[test]
    fn number_to_string_matches_node() {
        assert_eq!(number_to_string(0.0), "0");
        assert_eq!(number_to_string(2.5), "2.5");
        assert_eq!(number_to_string(f64::INFINITY), "Infinity");
        assert_eq!(number_to_string(f64::NAN), "NaN");
    }
}
