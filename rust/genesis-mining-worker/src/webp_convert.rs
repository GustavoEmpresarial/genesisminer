//! Raster (`png`/`jpg`/`jpeg`/`gif`) → `.webp` on disk. Port of Node
//! `server/modules/admin/image-asset/services/webp-convert.ts`
//! (`convertRasterFileToWebp`), with `libwebp` in place of `sharp`.
//!
//! Not ported: the `compressMediaFileInPlace` pre-pass Node runs before
//! converting (`sharp` recompression + `ffmpeg` GIF palette). It is a
//! best-effort size optimisation on the *original* file, which this pipeline
//! deletes right after a successful conversion.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use genesis_core::image_paths::{
    is_convertible_raster_ext, lower_ext, webp_sibling_path, WEBP_EXT,
};
use image::codecs::gif::GifDecoder;
use image::{AnimationDecoder, ImageFormat, RgbaImage};
use tokio::fs;
use webp::{AnimEncoder, AnimFrame, Encoder, WebPConfig};

/// Node `WEBP_QUALITY_FLOOR` / `WEBP_QUALITY_CEILING` / `WEBP_QUALITY_DEFAULT`.
const WEBP_QUALITY_FLOOR: f32 = 50.0;
const WEBP_QUALITY_CEILING: f32 = 95.0;
pub const WEBP_QUALITY_DEFAULT: f32 = 85.0;
/// Node `WEBP_EFFORT` — `sharp`'s `effort` is libwebp's `WebPConfig.method`.
const WEBP_EFFORT: i32 = 4;

/// Node `convertRasterFileToWebp` error strings.
const ERR_MISSING: &str = "missing";
const ERR_EMPTY_OUT: &str = "empty_out";
const ERR_SKIP_EXT_PREFIX: &str = "skip_ext:";
const ERR_NO_SIBLING_PATH: &str = "no_sibling_path";
const ERR_CONFIG: &str = "webp_config";
const ERR_NO_FRAMES: &str = "no_frames";
const ERR_UNSUPPORTED_CONTENT: &str = "unsupported_content";
const ERR_ENCODE_PANIC: &str = "encode_task_failed";

/// Node `ConvertRasterFileToWebpResult`; its `ok` flag is `error.is_none()`
/// here — a no-op on an already-`.webp` file is a success without conversion.
#[derive(Debug, Clone)]
pub struct ConvertRasterFileToWebpResult {
    pub abs_path: PathBuf,
    pub converted: bool,
    pub error: Option<String>,
}

impl ConvertRasterFileToWebpResult {
    fn untouched(abs_path: &Path, error: Option<String>) -> Self {
        Self {
            abs_path: abs_path.to_path_buf(),
            converted: false,
            error,
        }
    }
}

/// Node `opts` of `convertRasterFileToWebp`.
#[derive(Debug, Clone, Copy)]
pub struct ConvertRasterFileToWebpOptions {
    pub quality: f32,
    pub remove_original: bool,
}

impl Default for ConvertRasterFileToWebpOptions {
    fn default() -> Self {
        Self {
            quality: WEBP_QUALITY_DEFAULT,
            remove_original: true,
        }
    }
}

fn clamp_quality(quality: f32) -> f32 {
    quality.clamp(WEBP_QUALITY_FLOOR, WEBP_QUALITY_CEILING)
}

fn webp_config(quality: f32) -> Result<WebPConfig, String> {
    let mut config = WebPConfig::new().map_err(|_| ERR_CONFIG.to_string())?;
    config.quality = quality;
    config.method = WEBP_EFFORT;
    Ok(config)
}

fn encode_still(bytes: &[u8], format: ImageFormat, quality: f32) -> Result<Vec<u8>, String> {
    let decoded = image::load_from_memory_with_format(bytes, format).map_err(|e| e.to_string())?;
    let rgba = decoded.to_rgba8();
    let config = webp_config(quality)?;
    let encoder = Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height());
    let out = encoder
        .encode_advanced(&config)
        .map_err(|e| format!("{e:?}"))?;
    Ok(out.to_vec())
}

/// Animated WebP, mirroring `sharp({ animated: true })` for GIF input. Frame
/// delays come from the GIF itself; the `webp` crate closes the animation at
/// timestamp `0`, so the last frame's on-screen duration is decided by the
/// muxer instead of the source delay.
fn encode_animated_gif(bytes: &[u8], quality: f32) -> Result<Vec<u8>, String> {
    let decoder = GifDecoder::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let frames = decoder
        .into_frames()
        .collect_frames()
        .map_err(|e| e.to_string())?;
    let mut timeline: Vec<(RgbaImage, i32)> = Vec::with_capacity(frames.len());
    let mut timestamp_ms: i32 = 0;
    for frame in frames {
        let (numer, denom) = frame.delay().numer_denom_ms();
        let delay_ms = numer.checked_div(denom).unwrap_or(0) as i32;
        timeline.push((frame.into_buffer(), timestamp_ms));
        timestamp_ms = timestamp_ms.saturating_add(delay_ms);
    }
    let Some((first, _)) = timeline.first() else {
        return Err(ERR_NO_FRAMES.to_string());
    };
    let (width, height) = (first.width(), first.height());
    let config = webp_config(quality)?;
    let mut encoder = AnimEncoder::new(width, height, &config);
    for (buffer, timestamp) in &timeline {
        encoder.add_frame(AnimFrame::from_rgba(
            buffer.as_raw(),
            buffer.width(),
            buffer.height(),
            *timestamp,
        ));
    }
    let out = encoder.try_encode().map_err(|e| format!("{e:?}"))?;
    Ok(out.to_vec())
}

/// Encodes to WebP based on the *content* (like `sharp`, which sniffs the
/// buffer) rather than the file extension.
fn encode_webp(bytes: &[u8], quality: f32) -> Result<Vec<u8>, String> {
    match image::guess_format(bytes).map_err(|e| e.to_string())? {
        ImageFormat::Gif => encode_animated_gif(bytes, quality),
        format @ (ImageFormat::Png | ImageFormat::Jpeg) => encode_still(bytes, format, quality),
        _ => Err(ERR_UNSUPPORTED_CONTENT.to_string()),
    }
}

/// Node `convertRasterFileToWebp`: writes the `.webp` sibling, drops the
/// original on success, and never propagates an error — callers keep serving
/// the original file when conversion is not possible.
pub async fn convert_raster_file_to_webp(
    abs_path: &Path,
    opts: ConvertRasterFileToWebpOptions,
) -> ConvertRasterFileToWebpResult {
    let is_file = fs::metadata(abs_path)
        .await
        .map(|m| m.is_file())
        .unwrap_or(false);
    if !is_file {
        return ConvertRasterFileToWebpResult::untouched(abs_path, Some(ERR_MISSING.to_string()));
    }
    let raw_path = abs_path.to_string_lossy().to_string();
    let ext = lower_ext(&raw_path);
    if ext == WEBP_EXT {
        return ConvertRasterFileToWebpResult::untouched(abs_path, None);
    }
    if !is_convertible_raster_ext(&ext) {
        return ConvertRasterFileToWebpResult::untouched(
            abs_path,
            Some(format!("{ERR_SKIP_EXT_PREFIX}{ext}")),
        );
    }
    let Some(out_path) = webp_sibling_path(&raw_path).map(PathBuf::from) else {
        return ConvertRasterFileToWebpResult::untouched(
            abs_path,
            Some(ERR_NO_SIBLING_PATH.to_string()),
        );
    };

    let bytes = match fs::read(abs_path).await {
        Ok(b) => b,
        Err(e) => return ConvertRasterFileToWebpResult::untouched(abs_path, Some(e.to_string())),
    };
    let quality = clamp_quality(opts.quality);
    let encoded = tokio::task::spawn_blocking(move || encode_webp(&bytes, quality)).await;
    let out = match encoded {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return ConvertRasterFileToWebpResult::untouched(abs_path, Some(e)),
        Err(_) => {
            return ConvertRasterFileToWebpResult::untouched(
                abs_path,
                Some(ERR_ENCODE_PANIC.to_string()),
            )
        }
    };
    if out.is_empty() {
        return ConvertRasterFileToWebpResult::untouched(abs_path, Some(ERR_EMPTY_OUT.to_string()));
    }
    if let Err(e) = fs::write(&out_path, &out).await {
        return ConvertRasterFileToWebpResult::untouched(abs_path, Some(e.to_string()));
    }
    if opts.remove_original && out_path != abs_path {
        // Node keeps the original when unlink fails.
        let _ = fs::remove_file(abs_path).await;
    }
    ConvertRasterFileToWebpResult {
        abs_path: out_path,
        converted: true,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::gif::{GifEncoder, Repeat};
    use image::{Delay, Frame, ImageBuffer, Rgb, Rgba};
    use std::path::PathBuf;
    use webp::AnimDecoder;

    const TEST_IMAGE_SIDE: u32 = 8;
    const WEBP_RIFF_MAGIC: &[u8] = b"RIFF";
    const WEBP_FORMAT_MAGIC: &[u8] = b"WEBP";
    const WEBP_FORMAT_MAGIC_OFFSET: usize = 8;
    const GIF_FRAME_COUNT: usize = 2;
    const GIF_FRAME_DELAY_MS: u32 = 100;
    const GIF_DELAY_DENOM: u32 = 1;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "genesis-webp-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir(tag: &str) -> TempDir {
        TempDir::new(tag)
    }

    fn gradient_rgba(shift: u32) -> ImageBuffer<Rgba<u8>, Vec<u8>> {
        ImageBuffer::from_fn(TEST_IMAGE_SIDE, TEST_IMAGE_SIDE, |x, _| {
            Rgba([
                ((x + shift) * u8::MAX as u32 / TEST_IMAGE_SIDE) as u8,
                0,
                0,
                u8::MAX,
            ])
        })
    }

    fn gradient_rgb() -> ImageBuffer<Rgb<u8>, Vec<u8>> {
        ImageBuffer::from_fn(TEST_IMAGE_SIDE, TEST_IMAGE_SIDE, |x, _| {
            Rgb([(x * u8::MAX as u32 / TEST_IMAGE_SIDE) as u8, 0, 0])
        })
    }

    fn write_png(path: &Path) {
        gradient_rgba(0)
            .save_with_format(path, ImageFormat::Png)
            .expect("png");
    }

    fn write_jpeg(path: &Path) {
        gradient_rgb()
            .save_with_format(path, ImageFormat::Jpeg)
            .expect("jpeg");
    }

    fn write_gif(path: &Path, frame_count: usize) {
        let file = std::fs::File::create(path).expect("gif file");
        let mut encoder = GifEncoder::new(file);
        encoder.set_repeat(Repeat::Infinite).expect("gif repeat");
        for shift in 0..frame_count {
            encoder
                .encode_frame(Frame::from_parts(
                    gradient_rgba(shift as u32),
                    0,
                    0,
                    Delay::from_numer_denom_ms(GIF_FRAME_DELAY_MS, GIF_DELAY_DENOM),
                ))
                .expect("gif frame");
        }
    }

    fn is_webp(bytes: &[u8]) -> bool {
        bytes.starts_with(WEBP_RIFF_MAGIC)
            && bytes[WEBP_FORMAT_MAGIC_OFFSET..].starts_with(WEBP_FORMAT_MAGIC)
    }

    #[tokio::test]
    async fn converts_png_and_removes_original() {
        let dir = temp_dir("png");
        let src = dir.join("logo.png");
        write_png(&src);

        let out =
            convert_raster_file_to_webp(&src, ConvertRasterFileToWebpOptions::default()).await;

        assert!(out.converted && out.error.is_none(), "{out:?}");
        assert_eq!(out.abs_path, dir.join("logo.webp"));
        assert!(is_webp(&std::fs::read(&out.abs_path).expect("webp bytes")));
        assert!(!src.exists(), "original png must be deleted");
    }

    #[tokio::test]
    async fn converts_jpeg_and_can_keep_original() {
        let dir = temp_dir("jpg");
        let src = dir.join("banner.jpg");
        write_jpeg(&src);

        let out = convert_raster_file_to_webp(
            &src,
            ConvertRasterFileToWebpOptions {
                quality: WEBP_QUALITY_DEFAULT,
                remove_original: false,
            },
        )
        .await;

        assert!(out.converted && out.error.is_none(), "{out:?}");
        assert_eq!(out.abs_path, dir.join("banner.webp"));
        assert!(src.exists(), "removeOriginal:false keeps the source");
    }

    #[tokio::test]
    async fn converts_animated_gif_keeping_every_frame() {
        let dir = temp_dir("gif");
        let src = dir.join("spin.gif");
        write_gif(&src, GIF_FRAME_COUNT);

        let out =
            convert_raster_file_to_webp(&src, ConvertRasterFileToWebpOptions::default()).await;

        assert!(out.converted && out.error.is_none(), "{out:?}");
        let bytes = std::fs::read(dir.join("spin.webp")).expect("webp bytes");
        assert!(is_webp(&bytes));
        let decoded = AnimDecoder::new(&bytes).decode().expect("animated webp");
        assert_eq!(decoded.len(), GIF_FRAME_COUNT);
        assert!(decoded.has_animation());
    }

    #[tokio::test]
    async fn converts_single_frame_gif() {
        let dir = temp_dir("gif1");
        let src = dir.join("static.gif");
        write_gif(&src, 1);

        let out =
            convert_raster_file_to_webp(&src, ConvertRasterFileToWebpOptions::default()).await;

        assert!(out.converted && out.error.is_none(), "{out:?}");
        assert!(is_webp(&std::fs::read(&out.abs_path).expect("webp bytes")));
        assert!(!src.exists());
    }

    #[tokio::test]
    async fn skips_webp_and_non_raster_and_missing() {
        let dir = temp_dir("skip");
        let already = dir.join("icon.webp");
        std::fs::write(&already, b"not-really-webp").expect("write");
        let noop = convert_raster_file_to_webp(&already, Default::default()).await;
        assert!(!noop.converted && noop.error.is_none());
        assert!(already.exists());

        let video = dir.join("clip.mp4");
        std::fs::write(&video, b"bytes").expect("write");
        let skipped = convert_raster_file_to_webp(&video, Default::default()).await;
        assert!(!skipped.converted);
        assert_eq!(skipped.error.as_deref(), Some("skip_ext:.mp4"));

        let missing = convert_raster_file_to_webp(&dir.join("ghost.png"), Default::default()).await;
        assert_eq!(missing.error.as_deref(), Some(ERR_MISSING));

        let as_dir = convert_raster_file_to_webp(dir.path(), Default::default()).await;
        assert_eq!(as_dir.error.as_deref(), Some(ERR_MISSING));
    }

    #[tokio::test]
    async fn corrupt_raster_keeps_original() {
        let dir = temp_dir("corrupt");
        let src = dir.join("broken.png");
        std::fs::write(&src, b"definitely-not-a-png").expect("write");

        let out = convert_raster_file_to_webp(&src, Default::default()).await;

        assert!(!out.converted);
        assert!(out.error.is_some());
        assert!(src.exists(), "unconvertible upload stays served as-is");
        assert!(!dir.join("broken.webp").exists());
    }

    #[test]
    fn quality_clamp_matches_node() {
        assert_eq!(clamp_quality(WEBP_QUALITY_DEFAULT), WEBP_QUALITY_DEFAULT);
        assert_eq!(clamp_quality(0.0), WEBP_QUALITY_FLOOR);
        assert_eq!(clamp_quality(100.0), WEBP_QUALITY_CEILING);
        assert_eq!(
            ConvertRasterFileToWebpOptions::default().quality,
            WEBP_QUALITY_DEFAULT
        );
        assert!(ConvertRasterFileToWebpOptions::default().remove_original);
    }

    #[test]
    fn config_carries_node_quality_and_effort() {
        let config = webp_config(WEBP_QUALITY_DEFAULT).expect("config");
        assert_eq!(config.quality, WEBP_QUALITY_DEFAULT);
        assert_eq!(config.method, WEBP_EFFORT);
        assert_eq!(config.lossless, 0, "node uses lossy webp for uploads");
    }
}
