//! Support attachment download — basename only, no `..`.

use std::path::{Component, Path};

/// Node `SUPPORT_STORED_RE` + reject `..` / `/` / NUL.
pub fn is_safe_support_stored_filename(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() || n.contains('/') || n.contains('\\') || n.contains("..") || n.contains('\0') {
        return false;
    }
    let lower = n.to_ascii_lowercase();
    let rest = if let Some(r) = lower.strip_prefix("support-reply-") {
        r
    } else if let Some(r) = lower.strip_prefix("support-") {
        r
    } else {
        return false;
    };
    let mut parts = rest.splitn(3, '-');
    let a = parts.next().unwrap_or("");
    let b = parts.next().unwrap_or("");
    let c = parts.next().unwrap_or("");
    !a.is_empty()
        && a.chars().all(|ch| ch.is_ascii_digit())
        && !b.is_empty()
        && b.chars().all(|ch| ch.is_ascii_digit())
        && !c.is_empty()
        && c.chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-')
}

/// `path.basename` only — reject `..` and any parent component.
pub fn download_basename(file: &str) -> Option<String> {
    let n = file.trim();
    if n.is_empty() || n.contains('\0') || n.contains("..") {
        return None;
    }
    let path = Path::new(n);
    if path.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return None;
    }
    if n.contains('/') || n.contains('\\') {
        return None;
    }
    let base = path.file_name()?.to_str()?;
    if base != n {
        return None;
    }
    if !is_safe_support_stored_filename(base) {
        return None;
    }
    Some(base.to_string())
}

pub fn support_stored_file_owned_by_user(stored_name: &str, user_id: i64) -> bool {
    let lower = stored_name.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("support-") else {
        return false;
    };
    if rest.starts_with("reply-") {
        return false;
    }
    let uid = rest.split('-').next().and_then(|s| s.parse::<i64>().ok());
    uid == Some(user_id)
}

pub fn is_support_reply_stored_name(stored_name: &str) -> bool {
    stored_name
        .to_ascii_lowercase()
        .starts_with("support-reply-")
}

pub fn content_type_for_ext(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basename_rejects_dotdot() {
        assert!(download_basename("../../etc/passwd").is_none());
        assert!(download_basename("..").is_none());
        assert!(download_basename("foo/../support-1-1-x.png").is_none());
        assert!(download_basename("support-1-1-x.png/..").is_none());
    }

    #[test]
    fn basename_rejects_slash_and_unsafe() {
        assert!(download_basename("a/b.png").is_none());
        assert!(download_basename("not-support.png").is_none());
        assert!(download_basename("").is_none());
    }

    #[test]
    fn basename_accepts_support_name() {
        assert_eq!(
            download_basename("support-7-1000-500.png").as_deref(),
            Some("support-7-1000-500.png")
        );
        assert_eq!(
            download_basename("support-reply-1-1000-500.png").as_deref(),
            Some("support-reply-1-1000-500.png")
        );
    }

    #[test]
    fn owned_player_file() {
        assert!(support_stored_file_owned_by_user("support-7-1-1.png", 7));
        assert!(!support_stored_file_owned_by_user("support-7-1-1.png", 8));
        assert!(!support_stored_file_owned_by_user(
            "support-reply-7-1-1.png",
            7
        ));
    }
}
