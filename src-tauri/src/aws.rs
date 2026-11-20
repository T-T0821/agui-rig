//! AWS の認証情報とクライアント。
//!
//! 共通基盤の ID トークンを STS AssumeRoleWithWebIdentity で一時 IAM 認証情報に
//! 交換して使う。長期のアクセスキーはどこにも置かない。
//! OAuth を設定していない場合 (開発用) は、AWS SDK 標準の探索順 (環境変数、
//! ~/.aws の profile / SSO など) で認証する。
//!
//! テストや VPC エンドポイント向けには、AWS SDK 標準の環境変数
//! `AWS_ENDPOINT_URL_STS` / `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` /
//! `AWS_ENDPOINT_URL_BEDROCK_AGENTCORE` でエンドポイントを上書きできる。

use std::sync::{Arc, RwLock};
use std::time::SystemTime;

use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_credential_types::Credentials;
use aws_credential_types::provider::error::CredentialsError;
use aws_credential_types::provider::{ProvideCredentials, future};

/// `.env` などから読む AWS の設定。
#[derive(Clone, Debug)]
pub struct AwsSettings {
    pub region: String,
    /// ID トークンで引き受ける IAM ロール。None なら SDK 標準の認証 (開発用)
    pub role_arn: Option<String>,
}

impl AwsSettings {
    pub fn from_env() -> Self {
        Self {
            region: std::env::var("AWS_REGION").unwrap_or_else(|_| "ap-northeast-1".into()),
            role_arn: std::env::var("AWS_ROLE_ARN").ok().filter(|s| !s.is_empty()),
        }
    }
}

/// ログイン中ユーザーの ID トークン。リフレッシュで差し替わる。
#[derive(Clone, Debug, Default)]
pub struct IdToken(Arc<RwLock<String>>);

impl IdToken {
    pub fn new(token: String) -> Self {
        Self(Arc::new(RwLock::new(token)))
    }
    pub fn set(&self, token: String) {
        *self.0.write().unwrap() = token;
    }
    pub fn get(&self) -> String {
        self.0.read().unwrap().clone()
    }
}

/// ID トークンで STS AssumeRoleWithWebIdentity を呼ぶ credential provider。
/// SDK が期限切れ前に自動で呼び直すので、常に最新の ID トークンが使われる。
#[derive(Debug)]
struct WebIdentityProvider {
    sts: aws_sdk_sts::Client,
    role_arn: String,
    session_name: String,
    token: IdToken,
}

impl ProvideCredentials for WebIdentityProvider {
    fn provide_credentials<'a>(&'a self) -> future::ProvideCredentials<'a>
    where
        Self: 'a,
    {
        future::ProvideCredentials::new(async move {
            let output = self
                .sts
                .assume_role_with_web_identity()
                .role_arn(&self.role_arn)
                .role_session_name(&self.session_name)
                .web_identity_token(self.token.get())
                .send()
                .await
                .map_err(CredentialsError::provider_error)?;
            let c = output
                .credentials()
                .ok_or_else(|| CredentialsError::not_loaded("STS が認証情報を返しませんでした"))?;
            Ok(Credentials::new(
                c.access_key_id(),
                c.secret_access_key(),
                Some(c.session_token().to_string()),
                SystemTime::try_from(*c.expiration()).ok(),
                "AssumeRoleWithWebIdentity",
            ))
        })
    }
}

/// CloudTrail に残るロールセッション名 (使える文字は [\w+=,.@-]、64 文字まで)。
pub fn session_name(user: &str) -> String {
    let name: String = format!("chat-{user}")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "_+=,.@-".contains(c) { c } else { '_' })
        .take(64)
        .collect();
    name
}

/// AWS SDK の設定を作る。`token` があれば ID トークン → STS の一時認証情報を使う。
pub async fn sdk_config(settings: &AwsSettings, token: Option<(IdToken, String)>) -> Result<SdkConfig, String> {
    let region = Region::new(settings.region.clone());
    let loader = aws_config::defaults(BehaviorVersion::latest()).region(region.clone());

    let loader = match (&settings.role_arn, token) {
        (Some(role_arn), Some((token, user))) => {
            // STS の AssumeRoleWithWebIdentity は認証情報なしで呼べる
            let sts_config = aws_config::defaults(BehaviorVersion::latest())
                .region(region)
                .no_credentials()
                .load()
                .await;
            loader.credentials_provider(WebIdentityProvider {
                sts: aws_sdk_sts::Client::new(&sts_config),
                role_arn: role_arn.clone(),
                session_name: session_name(&user),
                token,
            })
        }
        (Some(_), None) => return Err("ログインしていません".into()),
        (None, _) => loader, // 開発用: SDK 標準の探索順
    };
    Ok(loader.load().await)
}
