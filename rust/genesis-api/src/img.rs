//! `/img` static — `IMG_UPLOADS_DIR` then `IMG_DIR`. No path traversal.
//!
//! Legacy URL fallbacks mirror Node `static-serving.ts`: flat
//! `/img/<basename>` lookups, catalog relocation between canonical/alias
//! subfolders, and `.webp` siblings for rasters already converted on disk.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use genesis_core::image_paths::{
    is_catalog_subfolder, is_convertible_raster_ext, is_flat_media_ext, legacy_folder_alias,
    lower_ext, webp_sibling_path, IMG_FLAT_NAME_LOOKUP_SUBFOLDERS, IMG_UPLOADS_SUBFOLDER,
};
use tokio_util::io::ReaderStream;

use crate::config::AppState;
use crate::download::content_type_for_ext;

const IMG_PREFIX: &str = "/img/";

/// Node `createCatalogRelocateFallbackMiddleware` only handles `<sub>/<file>`.
const CATALOG_RELOCATE_SEGMENTS: usize = 2;

fn safe_rel(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim_start_matches('/');
    if trimmed.is_empty() || trimmed.contains('\0') {
        return None;
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if out.as_os_str().is_empty() {
        return None;
    }
    Some(out)
}

async fn try_file(root: &Path, rel: &Path) -> Option<PathBuf> {
    let joined = root.join(rel);
    let canon_root = tokio::fs::canonicalize(root).await.ok()?;
    let canon_file = tokio::fs::canonicalize(&joined).await.ok()?;
    if !canon_file.starts_with(&canon_root) {
        return None;
    }
    let meta = tokio::fs::metadata(&canon_file).await.ok()?;
    if meta.is_file() {
        Some(canon_file)
    } else {
        None
    }
}

/// `rel` with its extension swapped for `.webp`, when the request asked for a
/// raster Node would have converted.
fn webp_sibling_rel(rel: &Path) -> Option<PathBuf> {
    let raw = rel.to_str()?;
    if !is_convertible_raster_ext(&lower_ext(raw)) {
        return None;
    }
    webp_sibling_path(raw).map(PathBuf::from)
}

/// Node `tryResolveExistingFile` — exact hit, else the `.webp` sibling.
async fn try_file_or_webp(root: &Path, rel: &Path) -> Option<PathBuf> {
    if let Some(hit) = try_file(root, rel).await {
        return Some(hit);
    }
    let sibling = webp_sibling_rel(rel)?;
    try_file(root, &sibling).await
}

fn rel_segments(rel: &Path) -> Vec<&str> {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect()
}

/// Node `resolveLegacyFlatImgFilePath` — `/img/<basename>` without subfolder.
async fn resolve_legacy_flat(uploads: &Path, img_dir: &Path, basename: &str) -> Option<PathBuf> {
    if !is_flat_media_ext(&lower_ext(basename)) {
        return None;
    }
    let rel = Path::new(basename);
    for sub in IMG_FLAT_NAME_LOOKUP_SUBFOLDERS {
        let dir = if sub == IMG_UPLOADS_SUBFOLDER {
            uploads.to_path_buf()
        } else {
            img_dir.join(sub)
        };
        if let Some(hit) = try_file_or_webp(&dir, rel).await {
            return Some(hit);
        }
    }
    None
}

/// Node `createCatalogRelocateFallbackMiddleware` — `/img/<sub>/<file>` after
/// the file was reclassified into another canonical subfolder.
async fn resolve_catalog_relocate(uploads: &Path, img_dir: &Path, rel: &Path) -> Option<PathBuf> {
    let parts = rel_segments(rel);
    if parts.len() != CATALOG_RELOCATE_SEGMENTS {
        return None;
    }
    let (sub, basename) = (parts[0], parts[1]);
    if !is_catalog_subfolder(sub) {
        return None;
    }
    if let Some(canonical) = legacy_folder_alias(sub) {
        if let Some(hit) = try_file(&img_dir.join(canonical), Path::new(basename)).await {
            return Some(hit);
        }
    }
    resolve_legacy_flat(uploads, img_dir, basename).await
}

/// Node `createWebpExtFallbackMiddleware` candidates: `IMG_DIR/<rel>`,
/// `IMG_UPLOADS_DIR/<rel>`, `IMG_UPLOADS_DIR/<basename>`.
async fn resolve_webp_sibling(uploads: &Path, img_dir: &Path, rel: &Path) -> Option<PathBuf> {
    let sibling = webp_sibling_rel(rel)?;
    for root in [img_dir, uploads] {
        if let Some(hit) = try_file(root, &sibling).await {
            return Some(hit);
        }
    }
    let basename = sibling.file_name().map(PathBuf::from)?;
    try_file(uploads, &basename).await
}

/// Exact file first (`IMG_UPLOADS_DIR` then `IMG_DIR`, as Node's two
/// `express.static` mounts), then the legacy-URL fallbacks in Node order.
async fn resolve_img_file(uploads: &Path, img_dir: &Path, rel: &Path) -> Option<PathBuf> {
    if let Some(hit) = try_file(uploads, rel).await {
        return Some(hit);
    }
    if let Some(hit) = try_file(img_dir, rel).await {
        return Some(hit);
    }
    if let [basename] = rel_segments(rel).as_slice() {
        if let Some(hit) = resolve_legacy_flat(uploads, img_dir, basename).await {
            return Some(hit);
        }
    }
    if let Some(hit) = resolve_catalog_relocate(uploads, img_dir, rel).await {
        return Some(hit);
    }
    resolve_webp_sibling(uploads, img_dir, rel).await
}

pub async fn serve_img(
    State(state): State<Arc<AppState>>,
    req: axum::http::Request<Body>,
) -> Response {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = req.uri().path();
    let rest = path.strip_prefix(IMG_PREFIX).unwrap_or("");
    let Some(rel) = safe_rel(rest) else {
        return (StatusCode::BAD_REQUEST, "Invalid path").into_response();
    };

    let uploads = PathBuf::from(&state.cfg.img_uploads_dir);
    let img_dir = PathBuf::from(&state.cfg.img_dir);

    let Some(file_path) = resolve_img_file(&uploads, &img_dir, &rel).await else {
        return StatusCode::NOT_FOUND.into_response();
    };

    if req.method() == Method::HEAD {
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::OK;
        if let Ok(ct) = header::HeaderValue::from_str(content_type_for_ext(
            file_path.to_string_lossy().as_ref(),
        )) {
            res.headers_mut().insert(header::CONTENT_TYPE, ct);
        }
        return res;
    }

    let file_handle = match tokio::fs::File::open(&file_path).await {
        Ok(f) => f,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let stream = ReaderStream::new(file_handle);
    let mut res = Response::new(Body::from_stream(stream));
    *res.status_mut() = StatusCode::OK;
    if let Ok(ct) =
        header::HeaderValue::from_str(content_type_for_ext(file_path.to_string_lossy().as_ref()))
    {
        res.headers_mut().insert(header::CONTENT_TYPE, ct);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal() {
        assert!(safe_rel("../etc/passwd").is_none());
        assert!(safe_rel("foo/../../etc/passwd").is_none());
        assert!(safe_rel("").is_none());
        assert_eq!(
            safe_rel("/uploads/x.png").as_deref(),
            Some(Path::new("uploads/x.png"))
        );
    }

    struct ImgRoots {
        root: PathBuf,
        uploads: PathBuf,
        img_dir: PathBuf,
    }

    impl ImgRoots {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "genesis-img-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            let uploads = root.join("uploads");
            let img_dir = root.join("media-seed");
            std::fs::create_dir_all(&uploads).expect("uploads dir");
            std::fs::create_dir_all(&img_dir).expect("img dir");
            Self {
                root,
                uploads,
                img_dir,
            }
        }

        fn write(&self, base: &Path, rel: &str) -> PathBuf {
            let abs = base.join(rel);
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent).expect("parent dir");
            }
            std::fs::write(&abs, rel.as_bytes()).expect("write asset");
            abs.canonicalize().expect("canonical asset")
        }

        async fn resolve(&self, rel: &str) -> Option<PathBuf> {
            resolve_img_file(&self.uploads, &self.img_dir, &safe_rel(rel)?).await
        }
    }

    impl Drop for ImgRoots {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[tokio::test]
    async fn exact_file_wins_uploads_then_img_dir() {
        let roots = ImgRoots::new("exact");
        let in_uploads = roots.write(&roots.uploads, "ad-1.png");
        let in_img = roots.write(&roots.img_dir, "miner/m1.png");
        roots.write(&roots.img_dir, "ad-1.png");

        assert_eq!(roots.resolve("ad-1.png").await, Some(in_uploads));
        assert_eq!(roots.resolve("miner/m1.png").await, Some(in_img));
        assert_eq!(roots.resolve("miner/ghost.png").await, None);
    }

    #[tokio::test]
    async fn serves_webp_sibling_when_requested_raster_is_gone() {
        let roots = ImgRoots::new("webp");
        let sub_webp = roots.write(&roots.img_dir, "rack/r1.webp");
        let upload_webp = roots.write(&roots.uploads, "ad-2.webp");

        assert_eq!(roots.resolve("rack/r1.png").await, Some(sub_webp.clone()));
        assert_eq!(roots.resolve("rack/r1.jpg").await, Some(sub_webp.clone()));
        assert_eq!(roots.resolve("rack/r1.jpeg").await, Some(sub_webp.clone()));
        assert_eq!(roots.resolve("rack/r1.gif").await, Some(sub_webp));
        assert_eq!(roots.resolve("ad-2.png").await, Some(upload_webp));
    }

    #[tokio::test]
    async fn webp_sibling_only_for_convertible_rasters() {
        let roots = ImgRoots::new("nonraster");
        roots.write(&roots.img_dir, "landing/hero.webp");

        assert_eq!(roots.resolve("landing/hero.mp4").await, None);
        assert_eq!(roots.resolve("landing/hero.ico").await, None);
    }

    #[tokio::test]
    async fn flat_url_finds_file_inside_catalog_subfolder() {
        let roots = ImgRoots::new("flat");
        let hit = roots.write(&roots.img_dir, "battery/b1.png");
        let webp_hit = roots.write(&roots.img_dir, "coin/c1.webp");
        let ico_hit = roots.write(&roots.img_dir, "favicon/f1.ico");

        assert_eq!(roots.resolve("b1.png").await, Some(hit));
        assert_eq!(roots.resolve("c1.png").await, Some(webp_hit));
        assert_eq!(roots.resolve("f1.ico").await, Some(ico_hit));
    }

    #[tokio::test]
    async fn flat_lookup_prefers_uploads_over_catalog() {
        let roots = ImgRoots::new("flatorder");
        let uploads_hit = roots.write(&roots.uploads, "shared.png");
        roots.write(&roots.img_dir, "miner/shared.png");

        assert_eq!(roots.resolve("shared.png").await, Some(uploads_hit));
    }

    #[tokio::test]
    async fn relocated_and_aliased_subfolders_resolve() {
        let roots = ImgRoots::new("relocate");
        let relocated = roots.write(&roots.img_dir, "rack/moved.webp");
        let aliased = roots.write(&roots.img_dir, "battery/cell.png");

        // URL kept the old subfolder after the file was reclassified.
        assert_eq!(roots.resolve("miner/moved.webp").await, Some(relocated));
        // PT/plural alias folder in the URL.
        assert_eq!(roots.resolve("baterias/cell.png").await, Some(aliased));
        assert_eq!(roots.resolve("chat-audio/moved.webp").await, None);
    }

    #[tokio::test]
    async fn traversal_and_deep_paths_stay_blocked() {
        let roots = ImgRoots::new("traversal");
        let outside = roots.write(&roots.root, "secret.png");
        assert!(outside.exists());

        assert_eq!(roots.resolve("../secret.png").await, None);
        assert_eq!(roots.resolve("miner/../../secret.png").await, None);
        assert_eq!(roots.resolve("secret.png").await, None);
    }

    #[test]
    fn accepts_uploads_and_chat_audio() {
        assert_eq!(
            safe_rel("uploads/x.png").as_deref(),
            Some(Path::new("uploads/x.png"))
        );
        assert_eq!(
            safe_rel("chat-audio/a.webm").as_deref(),
            Some(Path::new("chat-audio/a.webm"))
        );
        assert_eq!(
            safe_rel("rack/m.webp").as_deref(),
            Some(Path::new("rack/m.webp"))
        );
    }
}
