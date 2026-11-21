//! チャット履歴と利用料金 (バックエンド: API Gateway → Lambda → DynamoDB / Langfuse)。
//!
//! API Gateway の HTTP API を、Auth0 の ID トークン (`Authorization: Bearer ...`) で呼ぶ。
//! JWT オーソライザーがトークンを検証し、Lambda はトークンの `sub` だけで利用者を分けるので、
//! 利用者は自分の会話にしか届かない。AWS の一時認証情報は使わない。
//! API は `infra/terraform`、Lambda のコードは `app/backend` にある。
//!
//! - `GET /threads` / `GET /threads/{id}` / `PUT /threads/{id}` / `DELETE /threads/{id}`
//! - `GET /usage` (利用料金と利用上限の状態。作っていなければ 404)
//!
//! 会話 1 件 = DynamoDB の 1 項目。メッセージ (AG-UI の形の JSON 配列) は gzip + base64 にして
//! 1 つの属性に入れる (項目の上限 400KB に収まるよう、大きすぎるツールの出力は切り詰める)。

use std::io::{Read, Write};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::aws::IdToken;

/// gzip + base64 後の上限 (DynamoDB の項目の上限 400KB から、ほかの属性の分を引いた値)。
const MAX_ENCODED_BYTES: usize = 350_000;

/// 上限の確認で、前回の `/usage` の結果を使い回す時間。上限に達しているときは毎回確かめ直す
/// (管理者のリセットをすぐ反映するため)。
const LIMIT_CHECK_TTL: Duration = Duration::from_secs(30);

pub struct History {
    http: reqwest::Client,
    url: String,
    token: IdToken,
    /// 最後に読んだ利用料金 (上限の確認用)
    last_usage: Mutex<Option<(Instant, Usage)>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

/// 利用料金 (Langfuse が計算したもの、USD) と利用上限の状態。
/// 上限まわりは古いバックエンドでは返らないので、無ければ「上限なし」として読む。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub today_usd: f64,
    pub month_usd: f64,
    pub month_start: String,
    /// 今月の上限 (USD)。上限なしなら None。上限は管理者が決める
    #[serde(default)]
    pub limit_usd: Option<f64>,
    /// 上限の集計の始まり (月初、または管理者が手動でリセットした時刻)
    #[serde(default)]
    pub period_start: Option<String>,
    /// period_start からの料金 (上限と比べる金額)
    #[serde(default)]
    pub period_usd: f64,
    #[serde(default)]
    pub warn: bool,
    #[serde(default)]
    pub blocked: bool,
}

impl Usage {
    /// 上限に達しているときの、画面に出す文言。
    fn blocked_message(&self) -> Option<String> {
        if !self.blocked {
            return None;
        }
        let limit = self.limit_usd.map(|l| format!(" (${l:.2})")).unwrap_or_default();
        Some(format!(
            "今月の利用上限{limit}に達したため、新しいメッセージを送れません。\
             上限は毎月 1 日に自動でリセットされます。急ぎの場合は管理者に上限の変更かリセットを依頼してください。"
        ))
    }
}

/// 会話のタイトル: 最初の利用者メッセージの先頭 40 文字。
fn title_of(messages: &[Value]) -> String {
    let text = messages
        .iter()
        .find(|m| m.get("role").and_then(Value::as_str) == Some("user"))
        .map(|m| match m.get("content") {
            Some(Value::String(t)) => t.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        })
        .unwrap_or_default();
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title: String = line.chars().take(40).collect();
    if line.chars().count() > 40 {
        title.push('…');
    }
    if title.is_empty() { "新しい会話".into() } else { title }
}

fn gzip_base64(messages: &[Value]) -> String {
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(Value::Array(messages.to_vec()).to_string().as_bytes()).unwrap();
    base64::engine::general_purpose::STANDARD.encode(gz.finish().unwrap())
}

/// 上限に収まるまで、ツールの出力を古い順に短くする。それでも大きければ古いメッセージから落とす。
fn encode(messages: &[Value]) -> String {
    let mut messages = messages.to_vec();
    let mut encoded = gzip_base64(&messages);
    let mut i = 0;
    while encoded.len() > MAX_ENCODED_BYTES && i < messages.len() {
        if messages[i].get("role").and_then(Value::as_str) == Some("tool")
            && let Some(Value::String(content)) = messages[i].get_mut("content")
            && content.chars().count() > 2000
        {
            *content = format!("{}\n…(長すぎるため履歴では省略しました)", content.chars().take(2000).collect::<String>());
            encoded = gzip_base64(&messages);
        }
        i += 1;
    }
    while encoded.len() > MAX_ENCODED_BYTES && messages.len() > 1 {
        messages.remove(0);
        encoded = gzip_base64(&messages);
    }
    encoded
}

fn decode(data: &str) -> Result<Vec<Value>, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    let mut json = String::new();
    GzDecoder::new(bytes.as_slice()).read_to_string(&mut json).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

impl History {
    pub fn new(url: String, token: IdToken) -> Self {
        Self { http: reqwest::Client::new(), url, token, last_usage: Mutex::new(None) }
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}{path}", self.url.trim_end_matches('/'))
    }

    /// API を呼ぶ。404 は `None`。
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Option<Value>, String> {
        let mut request = self.http.request(method, self.endpoint(path)).bearer_auth(self.token.get());
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|e| format!("チャット履歴の API に接続できません: {e}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let text = response.text().await.map_err(|e| format!("チャット履歴の API の応答を読めません ({status}): {e}"))?;
        if !status.is_success() {
            let message = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_default();
            return Err(format!("チャット履歴の API がエラーを返しました ({status}) {message}").trim_end().to_owned());
        }
        if text.is_empty() {
            return Ok(Some(Value::Null));
        }
        serde_json::from_str(&text).map(Some).map_err(|e| format!("チャット履歴の API の応答が不正です ({status}): {e}"))
    }

    /// 会話を保存する (同じ会話は上書き)。`messages` は会話の最初からの全メッセージ。
    pub async fn save(&self, thread_id: &str, messages: &[Value]) -> Result<(), String> {
        if messages.is_empty() {
            return Ok(());
        }
        let body = json!({ "title": title_of(messages), "messagesGz": encode(messages) });
        self.call(reqwest::Method::PUT, &format!("/threads/{}", path_segment(thread_id)), Some(body)).await?;
        Ok(())
    }

    /// 自分の会話の一覧 (新しい順)。
    pub async fn list(&self) -> Result<Vec<ThreadSummary>, String> {
        let data = self.call(reqwest::Method::GET, "/threads", None).await?.unwrap_or(Value::Array(vec![]));
        let mut threads: Vec<ThreadSummary> = serde_json::from_value(data).map_err(|e| e.to_string())?;
        threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(threads)
    }

    /// 会話のメッセージ (AG-UI の形) を古い順に返す。
    pub async fn load(&self, thread_id: &str) -> Result<Vec<Value>, String> {
        let data = self.call(reqwest::Method::GET, &format!("/threads/{}", path_segment(thread_id)), None).await?;
        match data.as_ref().and_then(|d| d["messagesGz"].as_str()) {
            Some(gz) => decode(gz),
            None => Ok(vec![]),
        }
    }

    /// 自分の利用料金。バックエンドで利用料金の機能を作っていなければ None。
    pub async fn usage(&self) -> Result<Option<Usage>, String> {
        let usage: Option<Usage> = match self.call(reqwest::Method::GET, "/usage", None).await? {
            Some(data) => Some(serde_json::from_value(data).map_err(|e| e.to_string())?),
            None => None,
        };
        if let Some(u) = &usage {
            *self.last_usage.lock().unwrap() = Some((Instant::now(), u.clone()));
        }
        Ok(usage)
    }

    /// 実行の前に、利用上限に達していないか確かめる。達していれば画面に出す文言を Err で返す。
    /// 利用料金の機能が無い (404) とき、または確かめられない (Langfuse の障害など) ときは止めない。
    pub async fn check_limit(&self) -> Result<(), String> {
        let cached = self.last_usage.lock().unwrap().clone();
        let usage = match cached {
            Some((at, u)) if !u.blocked && at.elapsed() < LIMIT_CHECK_TTL => Some(u),
            _ => match self.usage().await {
                Ok(u) => u,
                Err(e) => {
                    tracing::warn!("利用上限を確かめられないため、そのまま実行します: {e}");
                    return Ok(());
                }
            },
        };
        match usage.and_then(|u| u.blocked_message()) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    /// 会話を消す。
    pub async fn delete(&self, thread_id: &str) -> Result<(), String> {
        self.call(reqwest::Method::DELETE, &format!("/threads/{}", path_segment(thread_id)), None).await?;
        Ok(())
    }
}

/// 会話 ID を URL のパスに入れられる形にする (英数字・`-`・`_` 以外は % で書く)。
fn path_segment(id: &str) -> String {
    id.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_uses_first_user_message() {
        let messages = vec![json!({"role": "system", "content": "x"}), json!({"role": "user", "content": "  東京の\n天気を教えて  "})];
        assert_eq!(title_of(&messages), "東京の 天気を教えて");
        assert_eq!(title_of(&[]), "新しい会話");
    }

    #[test]
    fn path_segment_escapes() {
        assert_eq!(path_segment("abc-DEF_123"), "abc-DEF_123");
        assert_eq!(path_segment("../a b"), "%2E%2E%2Fa%20b");
    }

    #[test]
    fn usage_without_limit_fields() {
        // 上限の機能が入る前のバックエンドの応答
        let u: Usage = serde_json::from_value(json!({"todayUsd": 0.1, "monthUsd": 1.0, "monthStart": "2026-10-31T15:00:00Z"})).unwrap();
        assert!(u.limit_usd.is_none() && !u.blocked && u.blocked_message().is_none());
    }

    #[test]
    fn usage_blocked_message() {
        let u: Usage = serde_json::from_value(json!({
            "todayUsd": 1.0, "monthUsd": 12.0, "monthStart": "2026-10-31T15:00:00Z",
            "limitUsd": 10.0, "periodStart": "2026-10-31T15:00:00Z", "periodUsd": 12.0, "warn": true, "blocked": true
        }))
        .unwrap();
        assert!(u.blocked_message().unwrap().contains("$10.00"));
    }

    #[test]
    fn round_trip() {
        let messages = vec![json!({"id": "1", "role": "user", "content": "こんにちは"})];
        assert_eq!(decode(&encode(&messages)).unwrap(), messages);
    }

    #[test]
    fn large_history_fits() {
        // 圧縮しにくい大きなツール出力
        let noise: String = (0..400_000u32).map(|i| char::from(b'!' + ((i * 7919 % 94) as u8))).collect();
        let messages = vec![
            json!({"role": "user", "content": "q"}),
            json!({"role": "tool", "content": noise}),
            json!({"role": "assistant", "content": "a"}),
        ];
        let encoded = encode(&messages);
        assert!(encoded.len() <= MAX_ENCODED_BYTES);
        assert_eq!(decode(&encoded).unwrap().len(), 3);
    }
}
