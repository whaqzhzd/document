use serde::Deserialize;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

pub const EMBEDDED_ARCHIVE: &[u8] =
    include_bytes!(env!("DOCUMENT_DIST_ARCHIVE_PATH"));
const EMBEDDED_METADATA: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/assets/document-dist.json"));
const EXTRACT_MARKER: &str = ".extract-complete";

#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddedMetadata {
    #[serde(rename = "assetHash")]
    pub asset_hash: String,
}

pub fn embedded_metadata() -> Result<EmbeddedMetadata, String> {
    serde_json::from_str(EMBEDDED_METADATA).map_err(|error| format!("failed to parse embedded metadata: {error}"))
}

pub fn ensure_assets_extracted(target_dir: &Path, asset_hash: &str) -> Result<(), String> {
    if is_extraction_complete(target_dir, asset_hash) {
        return Ok(());
    }

    let staging_dir = staging_dir_for(target_dir);
    if staging_dir.exists() {
        fs::remove_dir_all(&staging_dir)
            .map_err(|error| format!("failed to remove stale staging dir {}: {error}", staging_dir.display()))?;
    }

    fs::create_dir_all(&staging_dir)
        .map_err(|error| format!("failed to create staging dir {}: {error}", staging_dir.display()))?;

    let cursor = Cursor::new(EMBEDDED_ARCHIVE);
    let decoder = zstd::stream::read::Decoder::new(cursor)
        .map_err(|error| format!("failed to create zstd decoder for embedded archive: {error}"))?;
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(&staging_dir)
        .map_err(|error| format!("failed to unpack archive into {}: {error}", staging_dir.display()))?;

    fs::write(staging_dir.join(EXTRACT_MARKER), asset_hash)
        .map_err(|error| format!("failed to write extract marker in {}: {error}", staging_dir.display()))?;

    if target_dir.exists() {
        fs::remove_dir_all(target_dir)
            .map_err(|error| format!("failed to remove old asset dir {}: {error}", target_dir.display()))?;
    }

    fs::rename(&staging_dir, target_dir)
        .map_err(|error| format!("failed to promote staging dir {}: {error}", staging_dir.display()))?;

    Ok(())
}

fn is_extraction_complete(target_dir: &Path, asset_hash: &str) -> bool {
    let marker_path = target_dir.join(EXTRACT_MARKER);
    let index_path = target_dir.join("index.html");

    if !marker_path.is_file() || !index_path.is_file() {
        return false;
    }

    match fs::read_to_string(marker_path) {
        Ok(value) => value.trim() == asset_hash,
        Err(_) => false,
    }
}

fn staging_dir_for(target_dir: &Path) -> PathBuf {
    let file_name = target_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("assets")
        .to_string();

    target_dir
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{file_name}.tmp"))
}
