//! Disk writes for chat audio / support attachments / partner avatars.
//!
//! Paths and limits copy Node `createChatAudioMulter`, `createSupportUploadMulter`,
//! `createPartnerAvatarMulter`. HTTP body cap = largest named file max + chat
//! audio max (multipart envelope slack from existing named consts).

use axum::extract::Multipart;
use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use tracing::warn;
use uuid::Uuid;

use crate::config::WorkerConfig;
use crate::webp_convert::{convert_raster_file_to_webp, ConvertRasterFileToWebpOptions};
use genesis_core::image_paths::public_path_to_webp;

/// Node `CHAT_AUDIO_MAX_BYTES`.
const CHAT_AUDIO_MAX_BYTES: usize = 1_500_000;
/// Node `SUPPORT_UPLOAD_MAX_MB` × `KB_PER_MB` × `BYTES_PER_KB`.
const SUPPORT_UPLOAD_MAX_MB: usize = 12;
const BYTES_PER_KB: usize = 1024;
const KB_PER_MB: usize = 1024;
const SUPPORT_UPLOAD_MAX_BYTES: usize = SUPPORT_UPLOAD_MAX_MB * KB_PER_MB * BYTES_PER_KB;
/// Node `AVATAR_UPLOAD_MAX_MB`.
const AVATAR_UPLOAD_MAX_MB: usize = 5;
const AVATAR_UPLOAD_MAX_BYTES: usize = AVATAR_UPLOAD_MAX_MB * BYTES_PER_KB * BYTES_PER_KB;
/// Multipart envelope slack = largest file max + chat audio max (both named).
pub const UPLOAD_HTTP_BODY_LIMIT_BYTES: usize = SUPPORT_UPLOAD_MAX_BYTES + CHAT_AUDIO_MAX_BYTES;

const _: () = assert!(CHAT_AUDIO_MAX_BYTES == 1_500_000);
const _: () = assert!(SUPPORT_UPLOAD_MAX_BYTES == 12_582_912);
const _: () = assert!(AVATAR_UPLOAD_MAX_BYTES == 5_242_880);

/// Node `CHAT_AUDIO_PUBLIC_PREFIX`.
const CHAT_AUDIO_PUBLIC_PREFIX: &str = "/img/chat-audio/";
const PARTNER_AVATAR_PUBLIC_PREFIX: &str = "/img/partner-avatars/";
/// Node `mountImageStaticMiddleware` mount — support attachments and admin
/// image uploads are both published straight under `/img`.
const IMG_PUBLIC_PREFIX: &str = "/img/";

/// Node `AUDIO_MAGIC_BYTES_HEAD_LEN` / `MAGIC_BYTES_MIN_LEN`.
const MAGIC_BYTES_HEAD_LEN: usize = 32;
const MAGIC_BYTES_MIN_LEN: usize = 12;

/// Node `ORIGINAL_NAME_BASE_MAX_LENGTH`.
const ORIGINAL_NAME_BASE_MAX_LENGTH: usize = 32;
/// Node `RANDOM_SUFFIX_SLICE_END - RANDOM_SUFFIX_SLICE_START`.
const RANDOM_SUFFIX_LEN: usize = 6;
/// Node `UNIQUE_SUFFIX_RANDOM_CEILING`.
const UNIQUE_SUFFIX_RANDOM_CEILING: u64 = 1_000_000_000;

/// Node `HTTP_BAD_REQUEST`.
const HTTP_BAD_REQUEST: u16 = 400;
/// Node `HTTP_PAYLOAD_TOO_LARGE`.
const HTTP_PAYLOAD_TOO_LARGE: u16 = 413;
/// Internal worker failure.
const HTTP_INTERNAL: u16 = 500;

pub const UPLOAD_CHAT_AUDIO_PATH: &str = "/v1/uploads/chat-audio";
pub const UPLOAD_SUPPORT_ATTACHMENT_PATH: &str = "/v1/uploads/support-attachment";
pub const UPLOAD_PARTNER_AVATAR_PATH: &str = "/v1/uploads/partner-avatar";
pub const UPLOAD_ADMIN_IMAGE_DATA_URL_PATH: &str = "/v1/uploads/admin-image-data-url";

/// Node `IMG_ADMIN_TARGET_SUBFOLDERS` (`image-asset-model.ts`) — the only
/// `assetFolder` values that redirect the write into the catalog root.
const IMG_ADMIN_TARGET_SUBFOLDERS: &[&str] = &[
    "miner", "rack", "fan", "chip", "battery", "charger", "coin", "partner", "favicon", "landing",
];

/// Node `DATA_URL_IMAGE_RE` mime group → stored extension.
const DATA_URL_IMAGE_EXT_BY_MIME: &[(&str, &str)] = &[
    ("image/png", ".png"),
    ("image/gif", ".gif"),
    ("image/jpeg", ".jpg"),
];

/// Node `DATA_URL_IMAGE_RE` prefix / separator.
const DATA_URL_SCHEME_PREFIX: &str = "data:";
const DATA_URL_BASE64_SEPARATOR: &str = ";base64,";

/// Node `sanitizeOriginalNameBase` fallback.
const DEFAULT_ORIGINAL_NAME: &str = "image";

/// Node `POST /api/upload-image` responses.
const ERR_MISSING_DATA_URL: &str = "Missing dataUrl";
const ERR_DATA_URL_MIME_NOT_ALLOWED: &str = "Only PNG/GIF/JPEG data URLs are allowed";
const ERR_WRITE_FAILED: &str = "Failed to write file";

/// `Buffer.from(b64, 'base64')` is forgiving about padding; mirror that so a
/// data URL Node accepted does not start failing here.
const B64_DATA_URL: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

const AUDIO_EXT_BY_MIME: &[(&str, &str)] = &[
    ("audio/webm", ".webm"),
    ("audio/ogg", ".ogg"),
    ("audio/mpeg", ".mp3"),
    ("audio/mp3", ".mp3"),
    ("audio/mp4", ".m4a"),
    ("audio/aac", ".aac"),
    ("audio/wav", ".wav"),
    ("audio/x-wav", ".wav"),
    ("video/webm", ".webm"),
];

const ALLOWED_AUDIO_EXT: &[&str] = &[".webm", ".ogg", ".mp3", ".m4a", ".mp4", ".aac", ".wav"];
const SUPPORT_ALLOWED_EXT: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm", ".mov",
];
const AVATAR_ALLOWED_EXT: &[&str] = &[".png", ".jpg", ".jpeg", ".webp"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadWriteResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stored_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug)]
pub struct UploadError {
    pub http_status: u16,
    pub code: &'static str,
    pub message: String,
}

impl UploadError {
    fn validation(message: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_BAD_REQUEST,
            code: "UPLOAD",
            message: message.into(),
        }
    }
    fn too_large(message: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_PAYLOAD_TOO_LARGE,
            code: "PAYLOAD_TOO_LARGE",
            message: message.into(),
        }
    }
    fn internal(message: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_INTERNAL,
            code: "INTERNAL",
            message: message.into(),
        }
    }
}

impl UploadWriteResponse {
    pub fn from_err(e: UploadError) -> Self {
        Self {
            ok: false,
            stored_name: None,
            public_url: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

struct IncomingFile {
    original_name: String,
    mime: String,
    bytes: Vec<u8>,
    user_id: i64,
    name_prefix: String,
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_ascii_lowercase()))
        .unwrap_or_default()
}

fn resolve_audio_ext(original_name: &str, mime: &str) -> Option<String> {
    let mime = mime
        .to_ascii_lowercase()
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    for (k, v) in AUDIO_EXT_BY_MIME {
        if *k == mime {
            return Some((*v).to_string());
        }
    }
    let ext = ext_of(original_name);
    if ALLOWED_AUDIO_EXT.contains(&ext.as_str()) {
        if ext == ".mp4" {
            return Some(".m4a".into());
        }
        return Some(ext);
    }
    None
}

fn looks_like_audio_magic(buf: &[u8]) -> bool {
    if buf.len() < MAGIC_BYTES_MIN_LEN {
        return false;
    }
    // RIFF....WAVE
    if buf[0] == 0x52 && buf[1] == 0x49 && buf[2] == 0x46 && buf[3] == 0x46 {
        return true;
    }
    // ID3
    if buf[0] == 0x49 && buf[1] == 0x44 && buf[2] == 0x33 {
        return true;
    }
    // MPEG frame sync
    if buf[0] == 0xff && (buf[1] & 0xe0) == 0xe0 {
        return true;
    }
    // OggS
    if buf[0] == 0x4f && buf[1] == 0x67 && buf[2] == 0x67 && buf[3] == 0x53 {
        return true;
    }
    // ftyp (mp4/m4a)
    if buf[4] == 0x66 && buf[5] == 0x74 && buf[6] == 0x79 && buf[7] == 0x70 {
        return true;
    }
    // EBML (webm/mkv)
    if buf[0] == 0x1a && buf[1] == 0x45 && buf[2] == 0xdf && buf[3] == 0xa3 {
        return true;
    }
    false
}

fn random_base36_suffix() -> String {
    let uuid = Uuid::new_v4();
    let bytes = uuid.as_bytes();
    const BASE36: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = String::with_capacity(RANDOM_SUFFIX_LEN);
    for i in 0..RANDOM_SUFFIX_LEN {
        out.push(BASE36[(bytes[i] as usize) % BASE36.len()] as char);
    }
    out
}

fn sanitize_original_name_base(original_name: &str) -> String {
    let raw: String = original_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(ORIGINAL_NAME_BASE_MAX_LENGTH)
        .collect();
    if raw.is_empty() {
        "image".into()
    } else {
        raw
    }
}

fn build_stored_upload_filename(safe_base: &str, ext: &str) -> String {
    format!(
        "{}_{}_{}{}",
        current_unix_ms(),
        random_base36_suffix(),
        safe_base,
        ext
    )
}

fn support_stored_name(prefix: &str, user_id: i64, ext: &str) -> String {
    let rand = (Uuid::new_v4().as_u128() as u64) % UNIQUE_SUFFIX_RANDOM_CEILING;
    format!("{prefix}-{user_id}-{}-{rand}{ext}", current_unix_ms())
}

async fn read_incoming(mut multipart: Multipart) -> Result<IncomingFile, UploadError> {
    let mut original_name = String::new();
    let mut mime = String::new();
    let mut bytes = Vec::new();
    let mut user_id: i64 = 0;
    let mut name_prefix = String::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| UploadError::validation(e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" | "audio" | "avatar" | "files" => {
                if let Some(fnm) = field.file_name() {
                    if original_name.is_empty() {
                        original_name = fnm.to_string();
                    }
                }
                if let Some(ct) = field.content_type() {
                    if mime.is_empty() {
                        mime = ct.to_string();
                    }
                }
                bytes = field
                    .bytes()
                    .await
                    .map_err(|e| UploadError::validation(e.to_string()))?
                    .to_vec();
            }
            "originalName" => {
                original_name = field
                    .text()
                    .await
                    .map_err(|e| UploadError::validation(e.to_string()))?;
            }
            "mime" => {
                mime = field
                    .text()
                    .await
                    .map_err(|e| UploadError::validation(e.to_string()))?;
            }
            "userId" => {
                let t = field
                    .text()
                    .await
                    .map_err(|e| UploadError::validation(e.to_string()))?;
                user_id = t.trim().parse().unwrap_or(0);
            }
            "namePrefix" => {
                name_prefix = field
                    .text()
                    .await
                    .map_err(|e| UploadError::validation(e.to_string()))?;
            }
            _ => {
                let _ = field.bytes().await;
            }
        }
    }
    if bytes.is_empty() {
        return Err(UploadError::validation("File missing."));
    }
    Ok(IncomingFile {
        original_name,
        mime,
        bytes,
        user_id,
        name_prefix,
    })
}

async fn write_file(dir: &str, stored_name: &str, bytes: &[u8]) -> Result<(), UploadError> {
    if stored_name.contains("..") || stored_name.contains('/') || stored_name.contains('\\') {
        return Err(UploadError::validation("Invalid filename."));
    }
    fs::create_dir_all(dir)
        .await
        .map_err(|e| UploadError::internal(e.to_string()))?;
    let path: PathBuf = Path::new(dir).join(stored_name);
    fs::write(&path, bytes)
        .await
        .map_err(|e| UploadError::internal(e.to_string()))?;
    Ok(())
}

pub async fn run_upload_chat_audio(
    cfg: &WorkerConfig,
    multipart: Multipart,
) -> Result<UploadWriteResponse, UploadError> {
    let incoming = read_incoming(multipart).await?;
    if incoming.bytes.len() > CHAT_AUDIO_MAX_BYTES {
        return Err(UploadError::too_large(
            "Audio too large (max ~1.5 MB / 30 s).",
        ));
    }
    let ext = resolve_audio_ext(&incoming.original_name, &incoming.mime).ok_or_else(|| {
        UploadError::validation("Formato de áudio inválido. Usa WebM, OGG, MP3 ou M4A.")
    })?;
    let head_len = incoming.bytes.len().min(MAGIC_BYTES_HEAD_LEN);
    if !looks_like_audio_magic(&incoming.bytes[..head_len]) {
        return Err(UploadError::validation("Invalid audio file."));
    }
    let stored = build_stored_upload_filename("chat-audio", &ext);
    write_file(&cfg.chat_audio_dir, &stored, &incoming.bytes).await?;
    Ok(UploadWriteResponse {
        ok: true,
        stored_name: Some(stored.clone()),
        public_url: Some(format!("{CHAT_AUDIO_PUBLIC_PREFIX}{stored}")),
        error: None,
        code: None,
    })
}

pub async fn run_upload_support_attachment(
    cfg: &WorkerConfig,
    multipart: Multipart,
) -> Result<UploadWriteResponse, UploadError> {
    let incoming = read_incoming(multipart).await?;
    if incoming.bytes.len() > SUPPORT_UPLOAD_MAX_BYTES {
        return Err(UploadError::too_large(
            "One or more files exceed the size limit. Reduce size or send fewer attachments.",
        ));
    }
    let ext = ext_of(&incoming.original_name);
    if !SUPPORT_ALLOWED_EXT.contains(&ext.as_str()) {
        return Err(UploadError::validation(
            "File type not allowed (images or mp4/webm/mov video).",
        ));
    }
    let prefix = match incoming.name_prefix.trim() {
        "support-reply" => "support-reply",
        _ => "support",
    };
    let uid = if incoming.user_id > 0 {
        incoming.user_id
    } else {
        0
    };
    let stored = support_stored_name(prefix, uid, &ext);
    write_file(&cfg.support_upload_dir, &stored, &incoming.bytes).await?;
    Ok(UploadWriteResponse {
        ok: true,
        stored_name: Some(stored.clone()),
        public_url: Some(format!("{IMG_PUBLIC_PREFIX}{stored}")),
        error: None,
        code: None,
    })
}

pub async fn run_upload_partner_avatar(
    cfg: &WorkerConfig,
    multipart: Multipart,
) -> Result<UploadWriteResponse, UploadError> {
    let incoming = read_incoming(multipart).await?;
    if incoming.bytes.len() > AVATAR_UPLOAD_MAX_BYTES {
        return Err(UploadError::too_large("Invalid upload."));
    }
    let ext = ext_of(&incoming.original_name);
    let mime = incoming.mime.to_ascii_lowercase();
    if !AVATAR_ALLOWED_EXT.contains(&ext.as_str()) || !mime.starts_with("image/") {
        return Err(UploadError::validation(
            "Invalid format. Use PNG, JPG, or WEBP.",
        ));
    }
    let safe_base = format!(
        "partner-{}",
        sanitize_original_name_base(&incoming.original_name)
    );
    let stored = build_stored_upload_filename(&safe_base, &ext);
    write_file(&cfg.partner_avatar_dir, &stored, &incoming.bytes).await?;
    Ok(UploadWriteResponse {
        ok: true,
        stored_name: Some(stored.clone()),
        public_url: Some(format!("{PARTNER_AVATAR_PUBLIC_PREFIX}{stored}")),
        error: None,
        code: None,
    })
}

/// Node `POST /api/upload-image` body. Fields stay `Value` because the Node
/// controller branches on the runtime type (`typeof dataUrl !== 'string'`,
/// `typeof assetFolder === 'string'`, `sanitizeOriginalNameBase` on anything).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminImageDataUrlRequest {
    #[serde(default)]
    pub data_url: Value,
    #[serde(default)]
    pub original_name: Value,
    #[serde(default)]
    pub asset_folder: Value,
}

/// Node `parseDataUrlImageStrict`.
fn parse_data_url_image_strict(data_url: &str) -> Option<(Vec<u8>, &'static str)> {
    let rest = data_url.strip_prefix(DATA_URL_SCHEME_PREFIX)?;
    let (mime, b64) = rest.split_once(DATA_URL_BASE64_SEPARATOR)?;
    let (_, ext) = DATA_URL_IMAGE_EXT_BY_MIME
        .iter()
        .find(|(m, _)| *m == mime)?;
    if b64.is_empty() {
        return None;
    }
    let bytes = B64_DATA_URL.decode(b64).ok()?;
    Some((bytes, ext))
}

/// Node `String(originalName)` when it is neither `null` nor an object.
fn original_name_raw(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Null | Value::Array(_) | Value::Object(_) => DEFAULT_ORIGINAL_NAME.to_string(),
    }
}

/// Node `IMG_ADMIN_TARGET_SUBFOLDER_SET.has(assetFolder)` on a string value.
fn admin_target_subfolder(value: &Value) -> Option<&str> {
    let folder = value.as_str()?;
    IMG_ADMIN_TARGET_SUBFOLDERS
        .contains(&folder)
        .then_some(folder)
}

/// Node `POST /api/upload-image` write half. The `is_admin` check lives in
/// genesis-api (`require_is_admin`), so by the time we get here the actor is
/// already an admin — Node re-queried `users.is_admin` a second time before
/// honouring `assetFolder`, which was redundant with its own route guard.
pub async fn run_upload_admin_image_data_url(
    cfg: &WorkerConfig,
    req: AdminImageDataUrlRequest,
) -> Result<UploadWriteResponse, UploadError> {
    let data_url = req
        .data_url
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| UploadError::validation(ERR_MISSING_DATA_URL))?;
    let (bytes, ext) = parse_data_url_image_strict(data_url)
        .ok_or_else(|| UploadError::validation(ERR_DATA_URL_MIME_NOT_ALLOWED))?;
    let safe_base = sanitize_original_name_base(&original_name_raw(&req.original_name));
    let stored = build_stored_upload_filename(&safe_base, ext);
    let (dir, public_url) = match admin_target_subfolder(&req.asset_folder) {
        Some(folder) => (
            format!("{}/{folder}", cfg.img_dir),
            format!("{IMG_PUBLIC_PREFIX}{folder}/{stored}"),
        ),
        None => (
            cfg.img_uploads_dir.clone(),
            format!("{IMG_PUBLIC_PREFIX}{stored}"),
        ),
    };
    if let Err(e) = write_file(&dir, &stored, &bytes).await {
        warn!(err = %e.message, dir = %dir, "admin image data-url write failed");
        return Err(UploadError::internal(ERR_WRITE_FAILED));
    }
    let (stored, public_url) = finalize_upload_as_webp(&dir, stored, public_url).await;
    Ok(UploadWriteResponse {
        ok: true,
        stored_name: Some(stored),
        public_url: Some(public_url),
        error: None,
        code: None,
    })
}

/// Node `finalizeUploadAsWebp` (`image-asset.controller.ts`): converts the
/// stored raster to `.webp` and rewrites the public path to match. A conversion
/// that cannot happen keeps the original file and path — the upload response
/// never fails because of this optimisation.
async fn finalize_upload_as_webp(
    dir: &str,
    stored: String,
    public_url: String,
) -> (String, String) {
    let abs = Path::new(dir).join(&stored);
    let converted =
        convert_raster_file_to_webp(&abs, ConvertRasterFileToWebpOptions::default()).await;
    if !converted.converted {
        if let Some(err) = converted.error {
            warn!(err = %err, file = %stored, "admin image data-url kept unconverted");
        }
        return (stored, public_url);
    }
    match converted
        .abs_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
    {
        Some(webp_name) => (webp_name, public_path_to_webp(&public_url)),
        None => (stored, public_url),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TEST_PNG_SIDE: u32 = 4;

    struct TempUploadDir(PathBuf);

    impl TempUploadDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("genesis-upload-{tag}-{}", Uuid::new_v4().simple()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        fn as_str(&self) -> &str {
            self.0.to_str().expect("utf8 temp dir")
        }
    }

    impl Drop for TempUploadDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_png(path: &Path) {
        image::RgbaImage::from_pixel(
            TEST_PNG_SIDE,
            TEST_PNG_SIDE,
            image::Rgba([0, 0, u8::MAX, u8::MAX]),
        )
        .save_with_format(path, image::ImageFormat::Png)
        .expect("png");
    }

    #[tokio::test]
    async fn finalize_rewrites_stored_name_and_public_path_to_webp() {
        let dir = TempUploadDir::new("webp");
        let stored = "1700000000000_abc123_logo.png".to_string();
        write_png(&dir.0.join(&stored));

        let (name, public_url) = finalize_upload_as_webp(
            dir.as_str(),
            stored.clone(),
            format!("{IMG_PUBLIC_PREFIX}miner/{stored}"),
        )
        .await;

        assert_eq!(name, "1700000000000_abc123_logo.webp");
        assert_eq!(public_url, "/img/miner/1700000000000_abc123_logo.webp");
        assert!(dir.0.join(&name).is_file());
        assert!(!dir.0.join(&stored).exists(), "original raster is dropped");
    }

    #[tokio::test]
    async fn finalize_keeps_original_when_conversion_fails() {
        let dir = TempUploadDir::new("keep");
        let stored = "1700000000000_abc123_logo.png".to_string();
        std::fs::write(dir.0.join(&stored), b"not-a-real-png").expect("write");
        let public_url = format!("{IMG_PUBLIC_PREFIX}{stored}");

        let out = finalize_upload_as_webp(dir.as_str(), stored.clone(), public_url.clone()).await;

        assert_eq!(out, (stored.clone(), public_url));
        assert!(dir.0.join(&stored).is_file());
    }

    #[test]
    fn paths_and_limits_match_node() {
        assert_eq!(UPLOAD_CHAT_AUDIO_PATH, "/v1/uploads/chat-audio");
        assert_eq!(
            UPLOAD_SUPPORT_ATTACHMENT_PATH,
            "/v1/uploads/support-attachment"
        );
        assert_eq!(UPLOAD_PARTNER_AVATAR_PATH, "/v1/uploads/partner-avatar");
        assert_eq!(
            resolve_audio_ext("a.webm", "audio/webm").as_deref(),
            Some(".webm")
        );
        assert_eq!(
            resolve_audio_ext("a.mp4", "video/mp4").as_deref(),
            Some(".m4a")
        );
        assert!(looks_like_audio_magic(b"RIFF\0\0\0\0WAVEfmt \0\0\0\0"));
        assert!(!looks_like_audio_magic(b"not-audio-at-all-just-text"));
        assert_eq!(sanitize_original_name_base("Av@tar!.png"), "Avtarpng");
        assert_eq!(
            UPLOAD_ADMIN_IMAGE_DATA_URL_PATH,
            "/v1/uploads/admin-image-data-url"
        );
    }

    #[test]
    fn data_url_accepts_png_gif_jpeg_only() {
        let (bytes, ext) = parse_data_url_image_strict("data:image/png;base64,aGk=").unwrap();
        assert_eq!(bytes, b"hi");
        assert_eq!(ext, ".png");
        assert_eq!(
            parse_data_url_image_strict("data:image/gif;base64,aGk=")
                .unwrap()
                .1,
            ".gif"
        );
        assert_eq!(
            parse_data_url_image_strict("data:image/jpeg;base64,aGk=")
                .unwrap()
                .1,
            ".jpg"
        );
        assert!(parse_data_url_image_strict("data:image/svg+xml;base64,aGk=").is_none());
        assert!(parse_data_url_image_strict("data:image/png;base64,").is_none());
        assert!(parse_data_url_image_strict("data:image/png,aGk=").is_none());
        assert!(parse_data_url_image_strict("aGk=").is_none());
        assert!(parse_data_url_image_strict("data:image/png;base64,!!!").is_none());
    }

    #[test]
    fn unpadded_base64_still_decodes_like_node_buffer() {
        assert_eq!(
            parse_data_url_image_strict("data:image/png;base64,aGk")
                .unwrap()
                .0,
            b"hi"
        );
    }

    #[test]
    fn original_name_mirrors_node_string_coercion() {
        assert_eq!(original_name_raw(&json!("logo.png")), "logo.png");
        assert_eq!(original_name_raw(&json!(7)), "7");
        assert_eq!(original_name_raw(&json!(true)), "true");
        assert_eq!(original_name_raw(&Value::Null), DEFAULT_ORIGINAL_NAME);
        assert_eq!(original_name_raw(&json!({ "a": 1 })), DEFAULT_ORIGINAL_NAME);
        assert_eq!(original_name_raw(&json!([])), DEFAULT_ORIGINAL_NAME);
        assert_eq!(
            sanitize_original_name_base(&original_name_raw(&json!("../../etc/passwd"))),
            "etcpasswd"
        );
    }

    #[test]
    fn asset_folder_only_accepts_admin_targets() {
        assert_eq!(admin_target_subfolder(&json!("miner")), Some("miner"));
        assert_eq!(admin_target_subfolder(&json!("landing")), Some("landing"));
        // `uploads` / `support` are canonical but not admin upload targets.
        assert!(admin_target_subfolder(&json!("uploads")).is_none());
        assert!(admin_target_subfolder(&json!("support")).is_none());
        assert!(admin_target_subfolder(&json!("../escape")).is_none());
        assert!(admin_target_subfolder(&json!("")).is_none());
        assert!(admin_target_subfolder(&Value::Null).is_none());
        assert!(admin_target_subfolder(&json!(7)).is_none());
    }
}
