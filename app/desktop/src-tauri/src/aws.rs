//! AWS SDK の設定 (開発ビルドの、ログインしない開発モード専用)。
//!
//! 本番 (ログインして使う) では、アプリは AWS の認証情報を一切持たない。Bedrock と Code Interpreter は
//! バックエンドの LLM プロキシ (API Gateway → Lambda) が呼び、アプリは ID トークンでプロキシを呼ぶ (`proxy.rs`)。
//!
//! 開発モード (`pnpm dev:aws`、開発ビルドで OAuth 未設定) だけは、開発者自身の AWS 認証
//! (環境変数、~/.aws の profile / SSO など、AWS SDK 標準の探索順) で Bedrock と Code Interpreter を直接呼ぶ。
//! テストや VPC エンドポイント向けには、AWS SDK 標準の環境変数
//! `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` / `AWS_ENDPOINT_URL_BEDROCK_AGENTCORE` でエンドポイントを上書きできる。

use aws_config::{BehaviorVersion, Region, SdkConfig};

/// 開発モードで使うリージョン (`AWS_REGION`、既定 ap-northeast-1)。
pub fn region() -> String {
    std::env::var("AWS_REGION").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "ap-northeast-1".into())
}

/// 開発者自身の AWS 認証で SDK の設定を作る (開発モード専用)。
pub async fn dev_sdk_config() -> SdkConfig {
    aws_config::defaults(BehaviorVersion::latest()).region(Region::new(region())).load().await
}
