//! Resolve NFT / ASIC mining room id sets from `rig_rooms` (mirrors Node room-kind / nft-room-mining).

use std::collections::HashSet;

use anyhow::Context;
use tokio_postgres::Client;

use crate::config::{
    ASIC_POLICY_ROOM_NAME_KEYS, ASIC_ROOM_ID, NFT_AUTO_POLICY_ROOM_NAME_KEYS, NFT_AUTO_ROOM_ID,
};

async fn resolve_room_ids_by_id_or_name_keys(
    client: &Client,
    canonical_id: &str,
    name_keys: &[&str],
    err_label: &'static str,
) -> anyhow::Result<HashSet<String>> {
    let keys: Vec<&str> = name_keys.to_vec();
    let rows = client
        .query(
            r#"SELECT id FROM rig_rooms
             WHERE id = $1
                OR lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = ANY($2::text[])"#,
            &[&canonical_id, &keys],
        )
        .await
        .context(err_label)?;
    let mut ids = HashSet::new();
    for row in rows {
        let id: String = row.get("id");
        let trimmed = id.trim();
        if !trimmed.is_empty() {
            ids.insert(trimmed.to_string());
        }
    }
    ids.insert(canonical_id.to_string());
    Ok(ids)
}

pub async fn resolve_nft_auto_room_ids(client: &Client) -> anyhow::Result<HashSet<String>> {
    resolve_room_ids_by_id_or_name_keys(
        client,
        NFT_AUTO_ROOM_ID,
        NFT_AUTO_POLICY_ROOM_NAME_KEYS,
        "rig_rooms nft ids",
    )
    .await
}

pub async fn resolve_asic_room_ids(client: &Client) -> anyhow::Result<HashSet<String>> {
    resolve_room_ids_by_id_or_name_keys(
        client,
        ASIC_ROOM_ID,
        ASIC_POLICY_ROOM_NAME_KEYS,
        "rig_rooms asic ids",
    )
    .await
}
