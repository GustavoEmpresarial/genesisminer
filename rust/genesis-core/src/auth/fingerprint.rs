use super::constants::{
    ALLOW_COMPONENT_KEYS, MAX_COMPONENT_STRING_LENGTH, MAX_FINGERPRINT_PAYLOAD_CHARS,
    VISITOR_ID_MAX_LENGTH,
};
use super::types::SanitizedFingerprint;
use sha2::{Digest, Sha256};

fn visitor_id_ok(s: &str) -> bool {
    let len = s.len();
    if !(32..=128).contains(&len) {
        return false;
    }
    s.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn sanitize_device_fingerprint(raw: &serde_json::Value) -> Option<SanitizedFingerprint> {
    let obj = raw.as_object()?;
    let mut safe = serde_json::Map::new();

    if let Some(vid) = obj.get("visitorId").and_then(|v| v.as_str()) {
        if visitor_id_ok(vid) {
            let truncated: String = vid.chars().take(VISITOR_ID_MAX_LENGTH).collect();
            safe.insert("visitorId".into(), serde_json::Value::String(truncated));
        }
    }

    if let Some(components) = obj.get("components").and_then(|v| v.as_object()) {
        for key in ALLOW_COMPONENT_KEYS {
            let Some(v) = components.get(*key) else {
                continue;
            };
            match v {
                serde_json::Value::String(s) if s.len() <= MAX_COMPONENT_STRING_LENGTH => {
                    safe.insert((*key).into(), serde_json::Value::String(s.clone()));
                }
                serde_json::Value::Number(n)
                    if n.as_f64().map(|f| f.is_finite()).unwrap_or(false) =>
                {
                    safe.insert((*key).into(), serde_json::Value::Number(n.clone()));
                }
                serde_json::Value::Bool(b) => {
                    safe.insert((*key).into(), serde_json::Value::Bool(*b));
                }
                _ => {}
            }
        }
    }

    if safe.is_empty() {
        return None;
    }
    let payload_json = serde_json::Value::Object(safe).to_string();
    if payload_json.len() > MAX_FINGERPRINT_PAYLOAD_CHARS {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(payload_json.as_bytes());
    let fingerprint_hash = hex::encode(hasher.finalize());
    Some(SanitizedFingerprint {
        fingerprint_hash,
        payload_json,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitizes_allowed_keys() {
        let raw = json!({
            "visitorId": "abcdef0123456789abcdef0123456789",
            "components": { "platform": "Linux", "evil": "nope" }
        });
        let s = sanitize_device_fingerprint(&raw).unwrap();
        assert!(s.payload_json.contains("platform"));
        assert!(!s.payload_json.contains("evil"));
        assert_eq!(s.fingerprint_hash.len(), 64);
    }
}
