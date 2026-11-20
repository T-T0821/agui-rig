//! 共通基盤の OAuth (OpenID Connect) でのログイン。
//!
//! デスクトップアプリ向けの標準的な方式 (RFC 8252) で行う:
//! Authorization Code + PKCE、OS の既定ブラウザでログインし、
//! 127.0.0.1 のループバックでリダイレクトを受ける。クライアントシークレットは使わない。
//!
//! 取得したトークンは Rust のメモリ上だけに置き、WebView には渡さない。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::distr::{Alphanumeric, SampleString};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// `.env` などから読む OAuth の設定。
#[derive(Clone)]
pub struct OAuthConfig {
    /// 例: https://auth.example.com (/.well-known/openid-configuration を持つ URL)
    pub issuer: String,
    pub client_id: String,
    pub scopes: String,
    /// リダイレクトを受けるポート (0 なら空きポート。基盤側でポート固定が必要なら指定)
    pub redirect_port: u16,
}

impl OAuthConfig {
    /// OAUTH_ISSUER が無ければ None (ログインなしの開発モード)。
    pub fn from_env() -> Option<Self> {
        let issuer = std::env::var("OAUTH_ISSUER").ok().filter(|s| !s.trim().is_empty())?;
        Some(Self {
            issuer: issuer.trim_end_matches('/').to_string(),
            client_id: std::env::var("OAUTH_CLIENT_ID").unwrap_or_default(),
            scopes: std::env::var("OAUTH_SCOPES")
                .unwrap_or_else(|_| "openid profile email offline_access".into()),
            redirect_port: std::env::var("OAUTH_REDIRECT_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(0),
        })
    }
}

#[derive(Deserialize)]
struct Discovery {
    authorization_endpoint: String,
    token_endpoint: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
    refresh_token: Option<String>,
}

/// ログイン中のセッション。
#[derive(Clone)]
pub struct Session {
    pub id_token: String,
    pub refresh_token: Option<String>,
    /// 画面に出す名前 (ID トークンの name / email / sub)
    pub user: String,
    /// AWS のロールセッション名に使う ID (email / preferred_username / sub)
    pub principal: String,
    /// ID トークンの sub (利用者の不変の ID)。トレースの利用者 ID に使い、利用料金の集計キーになる
    pub sub: String,
    /// ID トークンの有効期限 (UNIX 秒)
    pub expires_at: u64,
}

impl Session {
    fn from_tokens(tokens: TokenResponse, previous_refresh: Option<String>) -> Result<Self, String> {
        let id_token = tokens.id_token.ok_or("ID トークンが返ってきませんでした (scope に openid が必要)")?;
        let claims = decode_claims(&id_token)?;
        let user = ["name", "email", "preferred_username", "sub"]
            .iter()
            .find_map(|k| claims.get(*k).and_then(|v| v.as_str()))
            .unwrap_or("user")
            .to_string();
        let principal = ["email", "preferred_username", "sub"]
            .iter()
            .find_map(|k| claims.get(*k).and_then(|v| v.as_str()))
            .unwrap_or("user")
            .to_string();
        let sub = claims.get("sub").and_then(|v| v.as_str()).ok_or("ID トークンに sub がありません")?.to_string();
        let expires_at = claims.get("exp").and_then(|v| v.as_u64()).unwrap_or(now() + 3600);
        Ok(Self {
            id_token,
            refresh_token: tokens.refresh_token.or(previous_refresh),
            user,
            principal,
            sub,
            expires_at,
        })
    }

    /// 更新が必要になるまでの時間 (期限の 2 分前)。
    pub fn refresh_in(&self) -> Duration {
        Duration::from_secs(self.expires_at.saturating_sub(now() + 120).max(5))
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

/// 署名の検証はしない (表示用の情報を読むだけ。検証は AWS STS が行う)。
fn decode_claims(jwt: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let payload = jwt.split('.').nth(1).ok_or("ID トークンの形式が不正です")?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub struct OAuthClient {
    config: OAuthConfig,
    http: reqwest::Client,
}

impl OAuthClient {
    pub fn new(config: OAuthConfig) -> Self {
        Self { config, http: reqwest::Client::new() }
    }

    async fn discover(&self) -> Result<Discovery, String> {
        let url = format!("{}/.well-known/openid-configuration", self.config.issuer);
        self.http
            .get(&url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("OIDC の設定を取得できません ({url}): {e}"))?
            .json()
            .await
            .map_err(|e| format!("OIDC の設定を読めません: {e}"))
    }

    /// ブラウザでログインしてもらい、トークンを取得する。
    /// `open_browser` には認可 URL が渡される。
    pub async fn login(&self, open_browser: impl FnOnce(&str)) -> Result<Session, String> {
        let discovery = self.discover().await?;

        let listener = TcpListener::bind(("127.0.0.1", self.config.redirect_port))
            .await
            .map_err(|e| format!("リダイレクト用のポートを開けません: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}/callback");

        // PKCE と state
        let verifier = Alphanumeric.sample_string(&mut rand::rng(), 64);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = Alphanumeric.sample_string(&mut rand::rng(), 32);

        let mut auth_url = url::Url::parse(&discovery.authorization_endpoint).map_err(|e| e.to_string())?;
        auth_url
            .query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &self.config.client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("scope", &self.config.scopes)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        open_browser(auth_url.as_str());

        // ブラウザからのリダイレクトを待つ (5 分でタイムアウト)
        let code = tokio::time::timeout(Duration::from_secs(300), wait_for_code(&listener, &state))
            .await
            .map_err(|_| "ログインがタイムアウトしました".to_string())??;

        let tokens: TokenResponse = self
            .token_request(
                &discovery.token_endpoint,
                &[
                    ("grant_type", "authorization_code"),
                    ("code", &code),
                    ("redirect_uri", &redirect_uri),
                    ("client_id", &self.config.client_id),
                    ("code_verifier", &verifier),
                ],
            )
            .await?;
        Session::from_tokens(tokens, None)
    }

    /// リフレッシュトークンで ID トークンを更新する。
    pub async fn refresh(&self, session: &Session) -> Result<Session, String> {
        let refresh_token = session
            .refresh_token
            .as_deref()
            .ok_or("リフレッシュトークンがありません")?;
        let discovery = self.discover().await?;
        let tokens = self
            .token_request(
                &discovery.token_endpoint,
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh_token),
                    ("client_id", &self.config.client_id),
                ],
            )
            .await?;
        Session::from_tokens(tokens, session.refresh_token.clone())
    }

    async fn token_request(&self, endpoint: &str, form: &[(&str, &str)]) -> Result<TokenResponse, String> {
        let response = self
            .http
            .post(endpoint)
            .form(form)
            .send()
            .await
            .map_err(|e| format!("トークンを取得できません: {e}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("トークンを取得できません ({status}): {body}"));
        }
        response.json().await.map_err(|e| format!("トークンを読めません: {e}"))
    }
}

/// ループバックで認可コードを受け取る。
async fn wait_for_code(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
        let request = String::from_utf8_lossy(&buf[..n]);
        let Some(target) = request.lines().next().and_then(|l| l.split_whitespace().nth(1)) else {
            continue;
        };
        let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{target}")) else { continue };
        if url.path() != "/callback" {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
            continue;
        }
        let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());

        let (result, message) = match (param("code"), param("state"), param("error")) {
            (_, _, Some(error)) => (Err(format!("ログインできませんでした: {error}")), "ログインできませんでした。"),
            (Some(code), Some(state), None) if state == expected_state => (Ok(code), "ログインしました。アプリに戻ってください。"),
            _ => (Err("ログインの応答が不正です (state 不一致)".to_string()), "ログインの応答が不正です。"),
        };
        let body = format!(
            "<!doctype html><meta charset=\"utf-8\"><title>Mastra Chat</title><p style=\"font-family:sans-serif;padding:2em\">{message}</p>"
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        return result;
    }
}
