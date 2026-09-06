//! Chat TTL purge — physical DELETE of expired `chat_messages` rows + disk cleanup.
//!
//! SQL mirrors Node `purgeExpiredChatMessages`. The worker cron (`chat_ttl_loop`)
//! owns Redis lock + SQL batches + audio unlink/orphan sweep under `chat_audio_dir`
//! (`IMG_UPLOADS_DIR` / `CHAT_AUDIO_DIR` shared volume), then publishes
//! `chat:ttl_purge` on `genesis:ws:emit` for genesis-api Socket.IO fanout.

use deadpool_postgres::Pool;
use genesis_core::time::MS_PER_HOUR;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::warn;

/// Node `CHAT_CHANNEL_GLOBAL`.
const CHAT_CHANNEL_GLOBAL: &str = "global";
/// Node `CHAT_AUDIO_PUBLIC_PREFIX`.
const CHAT_AUDIO_PUBLIC_PREFIX: &str = "/img/chat-audio/";
/// Node `CHAT_MESSAGE_TTL_MS` (1 hour).
const CHAT_MESSAGE_TTL_MS: i64 = MS_PER_HOUR as i64;
/// Node `PURGE_DEFAULT_LIMIT`.
const PURGE_DEFAULT_LIMIT: i64 = 2000;
/// Node `PURGE_MAX_LIMIT`.
const PURGE_MAX_LIMIT: i64 = 5000;

pub const CHAT_PURGE_EXPIRED_PATH: &str = "/v1/chat/purge-expired";

const AUDIO_EXTS: &[&str] = &["webm", "ogg", "mp3", "m4a", "mp4", "aac", "wav"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPurgeRequest {
    pub now_ms: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPurgeResponse {
    pub ok: bool,
    pub deleted: usize,
    pub ids: Vec<String>,
    pub channels: Vec<String>,
    pub audio_urls: Vec<String>,
    pub before_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn current_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn chat_message_cutoff_ms(now_ms: i64) -> i64 {
    now_ms - CHAT_MESSAGE_TTL_MS
}

/// Node: `Math.min(PURGE_MAX_LIMIT, Math.max(1, Math.floor(Number(opts?.limit) || PURGE_DEFAULT_LIMIT)))`.
fn clamp_purge_limit(raw: Option<i64>) -> i64 {
    let n = match raw {
        Some(v) if v > 0 => v,
        _ => PURGE_DEFAULT_LIMIT,
    };
    n.clamp(1, PURGE_MAX_LIMIT)
}

/// Node `isSafeChatAudioUrl` (no regex crate — manual allowlist).
pub fn is_safe_chat_audio_url(raw: &str) -> bool {
    let s = raw.trim();
    if !s.starts_with(CHAT_AUDIO_PUBLIC_PREFIX) {
        return false;
    }
    if s.contains("..")
        || s.contains('\\')
        || s.contains("://")
        || s.contains('?')
        || s.contains('#')
    {
        return false;
    }
    let name = &s[CHAT_AUDIO_PUBLIC_PREFIX.len()..];
    if name.is_empty() {
        return false;
    }
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if stem.is_empty() {
        return false;
    }
    if !stem
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return false;
    }
    let ext_l = ext.to_ascii_lowercase();
    AUDIO_EXTS.iter().any(|e| *e == ext_l)
}

fn audio_filename_from_url(url: &str) -> Option<&str> {
    if !is_safe_chat_audio_url(url) {
        return None;
    }
    Some(&url[CHAT_AUDIO_PUBLIC_PREFIX.len()..])
}

fn is_allowed_orphan_filename(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if stem.is_empty() {
        return false;
    }
    if !stem
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return false;
    }
    let ext_l = ext.to_ascii_lowercase();
    AUDIO_EXTS.iter().any(|e| *e == ext_l)
}

/// Unlink audio files returned by a purge batch (Node `unlinkChatAudioFiles`).
pub fn unlink_chat_audio_files(chat_audio_dir: &Path, audio_urls: &[String]) -> usize {
    let mut n = 0usize;
    for url in audio_urls {
        let Some(name) = audio_filename_from_url(url) else {
            continue;
        };
        let full: PathBuf = chat_audio_dir.join(name);
        match std::fs::remove_file(&full) {
            Ok(()) => n += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => warn!(file = %name, err = %e, "chat audio unlink failed"),
        }
    }
    n
}

/// Remove orphan files in chat-audio with mtime older than `before_ms` (Node `sweepOrphanChatAudio`).
pub fn sweep_orphan_chat_audio(chat_audio_dir: &Path, before_ms: i64) -> usize {
    let Ok(entries) = std::fs::read_dir(chat_audio_dir) else {
        return 0;
    };
    let mut n = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if !is_allowed_orphan_filename(name_str) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(mtime) = modified.duration_since(UNIX_EPOCH) else {
            continue;
        };
        let mtime_ms = mtime.as_millis() as i64;
        if mtime_ms >= before_ms {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => n += 1,
            Err(e) => warn!(file = %name_str, err = %e, "chat orphan unlink failed"),
        }
    }
    n
}

pub async fn run_purge_expired_chat_messages(
    pool: &Pool,
    now_ms: Option<i64>,
    limit: Option<i64>,
) -> Result<ChatPurgeResponse, String> {
    let now_ms = now_ms.unwrap_or_else(current_unix_ms);
    let before_ms = chat_message_cutoff_ms(now_ms);
    let limit = clamp_purge_limit(limit);

    let client = pool.get().await.map_err(|e| e.to_string())?;
    let rows = client
        .query(
            "DELETE FROM chat_messages
              WHERE id IN (
                SELECT id FROM chat_messages
                 WHERE created_at < $1
                 ORDER BY created_at ASC, id ASC
                 LIMIT $2
              )
              RETURNING id, channel, audio_url",
            &[&before_ms, &limit],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut ids: Vec<String> = Vec::with_capacity(rows.len());
    let mut channels: BTreeSet<String> = BTreeSet::new();
    let mut audio_urls: Vec<String> = Vec::new();

    for row in &rows {
        let id: i64 = row
            .try_get("id")
            .or_else(|_| row.try_get::<_, i32>("id").map(|v| i64::from(v)))
            .map_err(|e| e.to_string())?;
        ids.push(id.to_string());
        let channel: String = row
            .try_get::<_, String>("channel")
            .unwrap_or_else(|_| CHAT_CHANNEL_GLOBAL.to_string());
        let channel = if channel.is_empty() {
            CHAT_CHANNEL_GLOBAL.to_string()
        } else {
            channel
        };
        channels.insert(channel);
        let audio: Option<String> = row.try_get("audio_url").unwrap_or(None);
        if let Some(url) = audio {
            let trimmed = url.trim().to_string();
            if is_safe_chat_audio_url(&trimmed) {
                audio_urls.push(trimmed);
            }
        }
    }

    Ok(ChatPurgeResponse {
        ok: true,
        deleted: ids.len(),
        ids,
        channels: channels.into_iter().collect(),
        audio_urls,
        before_ms,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime};

    #[test]
    fn clamp_limit_defaults_and_bounds() {
        assert_eq!(clamp_purge_limit(None), PURGE_DEFAULT_LIMIT);
        assert_eq!(clamp_purge_limit(Some(0)), PURGE_DEFAULT_LIMIT);
        assert_eq!(clamp_purge_limit(Some(-5)), PURGE_DEFAULT_LIMIT);
        assert_eq!(clamp_purge_limit(Some(1)), 1);
        assert_eq!(clamp_purge_limit(Some(PURGE_MAX_LIMIT)), PURGE_MAX_LIMIT);
        assert_eq!(
            clamp_purge_limit(Some(PURGE_MAX_LIMIT + 1)),
            PURGE_MAX_LIMIT
        );
    }

    #[test]
    fn cutoff_is_one_hour() {
        assert_eq!(chat_message_cutoff_ms(3_600_000), 0);
        assert_eq!(CHAT_MESSAGE_TTL_MS, 3_600_000);
    }

    #[test]
    fn safe_audio_url_allowlist() {
        assert!(is_safe_chat_audio_url("/img/chat-audio/a.webm"));
        assert!(is_safe_chat_audio_url("/img/chat-audio/x.MP3"));
        assert!(!is_safe_chat_audio_url("/img/other/a.webm"));
        assert!(!is_safe_chat_audio_url("/img/chat-audio/../x.webm"));
        assert!(!is_safe_chat_audio_url("/img/chat-audio/a.exe"));
        assert!(!is_safe_chat_audio_url("/img/chat-audio/a.webm?x=1"));
        assert!(!is_safe_chat_audio_url(""));
    }

    #[test]
    fn unlink_and_orphan_sweep() {
        let dir = std::env::temp_dir().join(format!(
            "chat-purge-fs-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let keep = dir.join("keep.webm");
        let orphan = dir.join("orphan.mp3");
        let purged = dir.join("gone.webm");
        fs::write(&keep, b"k").unwrap();
        fs::write(&orphan, b"o").unwrap();
        fs::write(&purged, b"g").unwrap();
        let old = SystemTime::now() - Duration::from_secs(7200);
        let recent = SystemTime::now() + Duration::from_secs(60);
        filetime_set_mtime(&orphan, old);
        filetime_set_mtime(&keep, recent);

        let n = unlink_chat_audio_files(&dir, &["/img/chat-audio/gone.webm".to_string()]);
        assert_eq!(n, 1);
        assert!(!purged.exists());
        assert!(keep.exists());

        let before_ms = current_unix_ms();
        let orphans = sweep_orphan_chat_audio(&dir, before_ms);
        assert_eq!(orphans, 1);
        assert!(!orphan.exists());
        assert!(keep.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    fn filetime_set_mtime(path: &Path, mtime: SystemTime) {
        use std::fs::OpenOptions;
        let f = OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(mtime).unwrap();
    }
}
