use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"));
    let archive_path = manifest_dir.join("assets").join(".tmp").join("document-dist.tar");
    let metadata_path = manifest_dir.join("assets").join("document-dist.json");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("missing OUT_DIR"));
    let compressed_archive_path = out_dir.join("document-dist.tar.zst");
    let zstd_level = std::env::var("DOCUMENT_ZSTD_LEVEL")
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(10);

    println!("cargo:rerun-if-changed={}", archive_path.display());
    println!("cargo:rerun-if-changed={}", metadata_path.display());
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-env-changed=DOCUMENT_ZSTD_LEVEL");

    if !archive_path.exists() || !metadata_path.exists() {
        panic!(
            "Missing Rust asset bundle. Run `pnpm run build:rust-assets` in the document project before cargo build."
        );
    }

    let archive_bytes = std::fs::read(&archive_path)
        .unwrap_or_else(|error| panic!("failed to read staging archive {}: {error}", archive_path.display()));
    let compressed_bytes = zstd::stream::encode_all(std::io::Cursor::new(archive_bytes), zstd_level)
        .unwrap_or_else(|error| panic!("failed to compress staging archive with zstd: {error}"));
    std::fs::write(&compressed_archive_path, compressed_bytes).unwrap_or_else(|error| {
        panic!(
            "failed to write compressed archive {}: {error}",
            compressed_archive_path.display()
        )
    });

    println!(
        "cargo:rustc-env=DOCUMENT_DIST_ARCHIVE_PATH={}",
        compressed_archive_path.display()
    );
}
