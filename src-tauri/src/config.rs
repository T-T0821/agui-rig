//! 設定の読み込み。
//!
//! 値は、上にあるものほど優先される:
//! 1. 環境変数 (開発ビルドでは `.env` も読む)
//! 2. アプリの設定フォルダの `config.json` (利用者・端末ごとの上書き)
//!    Windows: `%APPDATA%\<identifier>\config.json`
//!    macOS:   `~/Library/Application Support/<identifier>/config.json`
//!    Linux:   `~/.config/<identifier>/config.json`
//! 3. ビルド時に埋め込んだ設定 (`APP_CONFIG=config/prod.json` でビルド)
//!
//! 設定ファイルのキーは環境変数と同じ名前。読み込んだ値は環境変数として設定するので、
//! アプリの各部分は今までどおり環境変数を読めばよい。
//! 秘密情報 (`SECRET_KEYS`) は設定ファイルからは読まない。

use std::path::PathBuf;

include!("config_keys.rs");

/// ビルド時に埋め込んだ設定 (build.rs が書き出したもの)。
const EMBEDDED: &str = include_str!(concat!(env!("OUT_DIR"), "/app-config.json"));

/// tauri.conf.json の identifier。Tauri の app_config_dir と同じ場所を、Tauri の起動前に求めるために使う。
const IDENTIFIER: &str = env!("APP_IDENTIFIER");

/// アプリの設定フォルダ (Tauri の `app_config_dir` と同じ)。
pub fn app_config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(IDENTIFIER))
}

/// どの値をどこから読んだか (起動ログ用。値そのものは出さない)。
pub struct Loaded {
    pub notes: Vec<String>,
}

/// 設定を読み込んで環境変数に入れる。ほかのスレッドを起動する前、`run()` の最初に呼ぶ。
pub fn load() -> Loaded {
    let mut notes = Vec::new();

    // .env は開発用。配布するリリースビルドでは読まない
    if cfg!(debug_assertions) && let Ok(path) = dotenvy::dotenv() {
        notes.push(format!(".env を読みました: {}", path.display()));
    }

    if let Some(path) = app_config_dir().map(|d| d.join("config.json")).filter(|p| p.is_file()) {
        match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|t| parse(&t)) {
            Ok(map) => apply(&map, &path.display().to_string(), &mut notes),
            Err(e) => notes.push(format!("{} を読めません: {e}", path.display())),
        }
    }

    match parse(EMBEDDED) {
        Ok(map) => apply(&map, "ビルド時の設定", &mut notes),
        Err(e) => notes.push(format!("ビルド時の設定を読めません: {e}")),
    }

    Loaded { notes }
}

fn parse(text: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    serde_json::from_str(text).map_err(|e| format!("JSON のオブジェクトではありません: {e}"))
}

/// まだ環境変数に無いキーだけ設定する (上の段の値を優先するため)。
fn apply(map: &serde_json::Map<String, serde_json::Value>, source: &str, notes: &mut Vec<String>) {
    let mut used = Vec::new();
    for (key, value) in map {
        if SECRET_KEYS.contains(&key.as_str()) {
            notes.push(format!("{source}: {key} は秘密情報なので無視しました (環境変数で渡してください)"));
            continue;
        }
        if !CONFIG_KEYS.contains(&key.as_str()) {
            notes.push(format!("{source}: {key} は使えないキーなので無視しました"));
            continue;
        }
        let Some(value) = value.as_str() else {
            notes.push(format!("{source}: {key} の値が文字列ではないので無視しました"));
            continue;
        };
        if std::env::var_os(key).is_none() {
            // SAFETY: 起動直後、ほかのスレッドを作る前に呼ばれる (load() の約束)
            unsafe { std::env::set_var(key, value) };
            used.push(key.as_str());
        }
    }
    if !used.is_empty() {
        notes.push(format!("{source} から: {}", used.join(", ")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_and_unknown_keys_are_ignored() {
        let map = parse(r#"{"LANGFUSE_SECRET_KEY":"sk","FOO":"x","AWS_REGION":1}"#).unwrap();
        let mut notes = Vec::new();
        apply(&map, "test", &mut notes);
        // 3 つとも無視され、何も設定されない
        assert_eq!(notes.len(), 3, "{notes:?}");
        assert!(notes.iter().all(|n| n.contains("無視")), "{notes:?}");
        assert!(std::env::var_os("FOO").is_none());
    }

    #[test]
    fn existing_env_wins() {
        // SAFETY: このテスト専用のキー
        unsafe { std::env::set_var("BEDROCK_MODEL_ID", "from-env") };
        let map = parse(r#"{"BEDROCK_MODEL_ID":"from-file","CODE_INTERPRETER_ID":"off"}"#).unwrap();
        apply(&map, "test", &mut Vec::new());
        assert_eq!(std::env::var("BEDROCK_MODEL_ID").unwrap(), "from-env");
        assert_eq!(std::env::var("CODE_INTERPRETER_ID").unwrap(), "off");
    }
}
