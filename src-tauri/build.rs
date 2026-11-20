//! ビルド時の設定の埋め込み。
//!
//! `APP_CONFIG` に JSON ファイルのパスを渡してビルドすると、その中身をバイナリに埋め込む。
//! 例: `APP_CONFIG=config/prod.json npx tauri build`
//! 未指定なら空の設定 (`{}`) を埋め込む。
//! 秘密情報や、知らないキーが入っていたらビルドを止める。

use std::path::PathBuf;

include!("src/config_keys.rs");

fn main() {
    println!("cargo:rerun-if-env-changed=APP_CONFIG");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("app-config.json");

    let json = match std::env::var("APP_CONFIG").ok().filter(|p| !p.trim().is_empty()) {
        Some(path) => {
            // パスはリポジトリのルートからでも src-tauri からでも書けるようにする
            let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
            let path = [PathBuf::from(&path), manifest.join(&path), manifest.join("..").join(&path)]
                .into_iter()
                .find(|p| p.is_file())
                .unwrap_or_else(|| panic!("APP_CONFIG のファイルが見つかりません: {path}"));
            println!("cargo:rerun-if-changed={}", path.display());
            let text = std::fs::read_to_string(&path).unwrap();
            let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("{} は JSON のオブジェクトではありません: {e}", path.display()));
            for (key, value) in &map {
                if SECRET_KEYS.contains(&key.as_str()) {
                    panic!("{key} は秘密情報なので、配布物に埋め込めません ({})", path.display());
                }
                if !CONFIG_KEYS.contains(&key.as_str()) {
                    panic!("{key} は設定ファイルで使えないキーです ({})", path.display());
                }
                if !value.is_string() {
                    panic!("{key} の値は文字列にしてください ({})", path.display());
                }
            }
            text
        }
        None => "{}".to_string(),
    };
    std::fs::write(out, json).unwrap();

    // tauri.conf.json の identifier (アプリの設定フォルダの名前) を Rust 側に渡す
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let conf: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("tauri.conf.json").unwrap()).unwrap();
    println!("cargo:rustc-env=APP_IDENTIFIER={}", conf["identifier"].as_str().unwrap());

    tauri_build::build()
}
