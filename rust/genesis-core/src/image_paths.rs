//! Pure `/img` asset path helpers — mirror of
//! `server/modules/admin/image-asset/services/webp-paths.ts` plus the path
//! halves of `image-asset-model.ts` (`FLAT_MEDIA_EXT`,
//! `IMG_FLAT_NAME_LOOKUP_SUBFOLDERS`, `IMG_LEGACY_FOLDER_ALIASES`). No I/O.

/// Node `CONVERTIBLE` (`webp-paths.ts`) — extensions converted to `.webp`.
pub const CONVERTIBLE_RASTER_EXT: [&str; 4] = [".png", ".jpg", ".jpeg", ".gif"];

/// Node `FLAT_MEDIA_EXT` (`image-asset-model.ts`) — extensions a flat
/// `/img/<basename>` URL is allowed to resolve.
pub const FLAT_MEDIA_EXT: [&str; 6] = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"];

/// Node `.webp` output extension.
pub const WEBP_EXT: &str = ".webp";

/// Node `IMG_CANONICAL_SUBFOLDERS`.
pub const IMG_CANONICAL_SUBFOLDERS: [&str; 12] = [
    "miner", "rack", "fan", "chip", "battery", "charger", "coin", "support", "partner", "favicon",
    "landing", "uploads",
];

/// Node `IMG_FLAT_NAME_LOOKUP_SUBFOLDERS` — runtime uploads first, then catalog.
pub const IMG_FLAT_NAME_LOOKUP_SUBFOLDERS: [&str; 12] = [
    "uploads", "support", "miner", "rack", "fan", "chip", "battery", "charger", "coin", "partner",
    "favicon", "landing",
];

/// Node `IMG_LEGACY_FOLDER_ALIASES` (PT / plural → canonical EN).
pub const IMG_LEGACY_FOLDER_ALIASES: [(&str, &str); 12] = [
    ("baterias", "battery"),
    ("batteries", "battery"),
    ("carregadores", "charger"),
    ("chargers", "charger"),
    ("moedas", "coin"),
    ("coins", "coin"),
    ("parceiros", "partner"),
    ("partners", "partner"),
    ("racks", "rack"),
    ("fans", "fan"),
    ("chips", "chip"),
    ("miners", "miner"),
];

/// Node subfolder served from the runtime uploads dir instead of `IMG_DIR/<sub>`.
pub const IMG_UPLOADS_SUBFOLDER: &str = "uploads";

/// `path.extname(name).toLowerCase()` for POSIX paths — `""` when the basename
/// has no extension (including dotfiles like `.gitignore`).
pub fn lower_ext(name: &str) -> String {
    let base_start = basename_start(name);
    let base = &name[base_start..];
    match base.rfind('.') {
        Some(0) | None => String::new(),
        Some(i) => base[i..].to_ascii_lowercase(),
    }
}

/// Node `isConvertibleRasterExt`.
pub fn is_convertible_raster_ext(ext: &str) -> bool {
    let lower = ext.to_ascii_lowercase();
    CONVERTIBLE_RASTER_EXT.contains(&lower.as_str())
}

/// Node `FLAT_MEDIA_EXT.has(ext)`.
pub fn is_flat_media_ext(ext: &str) -> bool {
    let lower = ext.to_ascii_lowercase();
    FLAT_MEDIA_EXT.contains(&lower.as_str())
}

/// Node `webpSiblingPath` — `None` when there is no extension to replace
/// (Node would return a bare `.webp`; every caller guards on the extension).
pub fn webp_sibling_path(path: &str) -> Option<String> {
    let base_start = basename_start(path);
    let dot = path[base_start..].rfind('.')?;
    if dot == 0 {
        return None;
    }
    Some(format!("{}{WEBP_EXT}", &path[..base_start + dot]))
}

/// Node `publicPathToWebp` — `/img/a/x.png?v=1` → `/img/a/x.webp?v=1`.
///
/// The Node regex also matches a raster extension that only appears inside the
/// query string; rewriting that would corrupt the query, so here the extension
/// is taken from the path part alone.
pub fn public_path_to_webp(public_path: &str) -> String {
    let (base, query) = match public_path.find('?') {
        Some(i) => public_path.split_at(i),
        None => (public_path, ""),
    };
    let ext = lower_ext(base);
    if !is_convertible_raster_ext(&ext) {
        return public_path.to_string();
    }
    format!("{}{WEBP_EXT}{query}", &base[..base.len() - ext.len()])
}

/// Node `IMG_LEGACY_FOLDER_ALIASES[sub]`.
pub fn legacy_folder_alias(sub: &str) -> Option<&'static str> {
    IMG_LEGACY_FOLDER_ALIASES
        .iter()
        .find(|(alias, _)| *alias == sub)
        .map(|(_, canonical)| *canonical)
}

/// Node `CATALOG_SUB_SET` (`static-serving.ts`) — canonical folders plus aliases.
pub fn is_catalog_subfolder(sub: &str) -> bool {
    IMG_CANONICAL_SUBFOLDERS.contains(&sub) || legacy_folder_alias(sub).is_some()
}

fn basename_start(path: &str) -> usize {
    path.rfind('/').map(|i| i + 1).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lower_ext_matches_node_extname() {
        assert_eq!(lower_ext("/img/miner/x.PNG"), ".png");
        assert_eq!(lower_ext("a.b.c"), ".c");
        assert_eq!(lower_ext("a."), ".");
        assert_eq!(lower_ext("noext"), "");
        assert_eq!(lower_ext(".gitignore"), "");
        assert_eq!(lower_ext("/dir.png/file"), "");
    }

    #[test]
    fn convertible_and_flat_ext_sets_match_node() {
        assert!(is_convertible_raster_ext(".png"));
        assert!(is_convertible_raster_ext(".JPEG"));
        assert!(!is_convertible_raster_ext(".webp"));
        assert!(!is_convertible_raster_ext(".ico"));
        assert!(is_flat_media_ext(".webp"));
        assert!(is_flat_media_ext(".ico"));
        assert!(!is_flat_media_ext(".mp4"));
    }

    #[test]
    fn webp_sibling_replaces_last_extension() {
        assert_eq!(
            webp_sibling_path("/srv/img/miner/x.png").as_deref(),
            Some("/srv/img/miner/x.webp")
        );
        assert_eq!(
            webp_sibling_path("/srv/img/a.b.jpeg").as_deref(),
            Some("/srv/img/a.b.webp")
        );
        assert!(webp_sibling_path("/srv/img/noext").is_none());
        assert!(webp_sibling_path("/srv/img/.hidden").is_none());
    }

    #[test]
    fn public_path_to_webp_rewrites_raster_only() {
        assert_eq!(public_path_to_webp("/img/x.png"), "/img/x.webp");
        assert_eq!(public_path_to_webp("/img/miner/x.JPG"), "/img/miner/x.webp");
        assert_eq!(public_path_to_webp("/img/x.jpeg?v=1"), "/img/x.webp?v=1");
        assert_eq!(public_path_to_webp("/img/x.gif"), "/img/x.webp");
        assert_eq!(public_path_to_webp("/img/x.webp"), "/img/x.webp");
        assert_eq!(public_path_to_webp("/img/x.mp4"), "/img/x.mp4");
        assert_eq!(
            public_path_to_webp("/img/x.webp?a=.png"),
            "/img/x.webp?a=.png"
        );
    }

    #[test]
    fn subfolder_sets_match_node() {
        assert_eq!(legacy_folder_alias("baterias"), Some("battery"));
        assert_eq!(legacy_folder_alias("miners"), Some("miner"));
        assert_eq!(legacy_folder_alias("miner"), None);
        assert!(is_catalog_subfolder("miner"));
        assert!(is_catalog_subfolder("uploads"));
        assert!(is_catalog_subfolder("racks"));
        assert!(!is_catalog_subfolder("chat-audio"));
        assert_eq!(
            IMG_FLAT_NAME_LOOKUP_SUBFOLDERS[0], IMG_UPLOADS_SUBFOLDER,
            "uploads must be probed first"
        );
    }
}
