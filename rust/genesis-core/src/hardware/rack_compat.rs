//! GPU/battery/wiring ↔ chassis compatibility — 1:1 with `rack-compat.ts`.

pub const MERGE_RESULT_RARITIES: &[&str] =
    &["supreme", "legendary", "uncommon", "common", "epic", "rare"];

pub const MERGE_HASH_MIN_LEN: usize = 6;
pub const MERGE_HASH_MAX_LEN: usize = 16;
pub const MERGE_LOOP_GUARD_MAX: u32 = 24;

const MERGE_PREFIX: &str = "merge_";

fn is_merge_hash(hash: &str) -> bool {
    let len = hash.len();
    if len < MERGE_HASH_MIN_LEN || len > MERGE_HASH_MAX_LEN {
        return false;
    }
    hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Peel one `merge_<source>_<rarity>_<hash>` layer. `None` if not a merge id.
pub fn peel_merge_catalog_layer(item_id: &str) -> Option<String> {
    let id = item_id.trim();
    if !id.starts_with(MERGE_PREFIX) {
        return None;
    }
    let body = &id[MERGE_PREFIX.len()..];
    let body_lower = body.to_ascii_lowercase();
    for rarity in MERGE_RESULT_RARITIES {
        let needle = format!("_{rarity}_");
        if let Some(idx) = body_lower.rfind(&needle) {
            let hash = &body[idx + needle.len()..];
            if !is_merge_hash(hash) {
                continue;
            }
            let source = &body[..idx];
            if !source.is_empty() {
                return Some(source.to_string());
            }
        }
    }
    None
}

/// Walk merge layers down to the catalog root (loop-guarded).
pub fn merge_catalog_root_id(item_id: &str) -> String {
    let mut id = item_id.trim().to_string();
    if id.is_empty() {
        return id;
    }
    let mut guard = 0u32;
    while id.starts_with(MERGE_PREFIX) && guard < MERGE_LOOP_GUARD_MAX {
        guard += 1;
        match peel_merge_catalog_layer(&id) {
            Some(next) if next != id => id = next,
            _ => break,
        }
    }
    id
}

/// Empty `compatible_racks` = fits every chassis. Otherwise exact + merge lineage.
pub fn is_compatible_with_rack(compatible_racks: Option<&[String]>, rack_item_id: &str) -> bool {
    let Some(list) = compatible_racks else {
        return true;
    };
    if list.is_empty() {
        return true;
    }
    let rack_id = rack_item_id.trim();
    if rack_id.is_empty() {
        return false;
    }
    if list.iter().any(|r| r == rack_id) {
        return true;
    }

    let rack_root = merge_catalog_root_id(rack_id);
    for raw in list {
        let listed = raw.trim();
        if listed.is_empty() {
            continue;
        }
        if listed == rack_id {
            return true;
        }
        let listed_root = merge_catalog_root_id(listed);
        if !listed_root.is_empty() && !rack_root.is_empty() && listed_root == rack_root {
            return true;
        }
        // Truncated 120-char ids still embed the base root.
        // `_base_` (underscores) avoids prefix collisions (rack_a61 vs rack_a610).
        if !listed.starts_with(MERGE_PREFIX) && rack_id.starts_with(MERGE_PREFIX) {
            let needle = format!("_{listed}_");
            if rack_id.contains(&needle) {
                return true;
            }
        }
        if !rack_id.starts_with(MERGE_PREFIX) && listed.starts_with(MERGE_PREFIX) {
            let needle = format!("_{rack_id}_");
            if listed.contains(&needle) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peel_valid_merge_layer() {
        assert_eq!(
            peel_merge_catalog_layer("merge_rack04_cores_uncommon_ab12cd").as_deref(),
            Some("rack04_cores")
        );
    }

    #[test]
    fn peel_non_merge_is_none() {
        assert_eq!(peel_merge_catalog_layer("rack04_cores"), None);
    }

    #[test]
    fn root_walks_to_base() {
        assert_eq!(
            merge_catalog_root_id("merge_rack04_cores_uncommon_ab12cd"),
            "rack04_cores"
        );
        assert_eq!(merge_catalog_root_id("rack04_cores"), "rack04_cores");
    }

    #[test]
    fn empty_compat_list_fits_all() {
        assert!(is_compatible_with_rack(Some(&[]), "qualquer_rack"));
        assert!(is_compatible_with_rack(None, "qualquer_rack"));
    }

    #[test]
    fn exact_match() {
        let listed = vec!["rack04".to_string()];
        assert!(is_compatible_with_rack(Some(&listed), "rack04"));
        assert!(!is_compatible_with_rack(Some(&listed), "rack05"));
    }

    #[test]
    fn merge_lineage_matches_root() {
        let listed = vec!["rack04_cores".to_string()];
        assert!(is_compatible_with_rack(
            Some(&listed),
            "merge_rack04_cores_uncommon_ab12cd"
        ));
    }

    #[test]
    fn empty_rack_id_never_matches_nonempty_list() {
        let listed = vec!["rack04".to_string()];
        assert!(!is_compatible_with_rack(Some(&listed), ""));
    }
}
