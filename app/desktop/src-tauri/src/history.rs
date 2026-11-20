//! チャット履歴と利用料金 (バックエンド: API Gateway → Lambda → DynamoDB / Langfuse)。
//!
//! API Gateway の HTTP API を、Auth0 の ID トークン (`Authorization: Bearer ...`) で呼ぶ。
//! JWT オーソライザーがトークンを検証し、Lambda はトークンの `sub` だけで利用者を分けるので、
//! 利用者は自分の会話にしか届かない。AWS の一時認証情報は使わない。
//! API は `infra/terraform`、Lambda のコードは `app/backend` にある。
//!
//! - `GET /threads` / `GET /threads/{id}` / `PUT /threads/{id}` / `DELETE /threads/{id}`
//! - `GET /usage` (利用料金。作っていなければ 404)
//!
//! 会話 1 件 = DynamoDB の 1 項目。メッセージ (AG-UI の形の JSON 配列) は gzip + base64 にして
//! 1 つの属性に入れる (項目の上限 400KB に収まるよう、大きすぎるツールの出力は切り詰める)。

use std::io::{Read, Write};

use base64::Engine;
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::aws::IdToken;

/// gzip + base64 後の上限 (DynamoDB の項目の上限 400KB から、ほかの属性の分を引いた値)。
const MAX_ENCODED_BYTES: usize = 350_000;

pub struct History {
    http: reqwest::Client,
    url: String,
    token: IdToken,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

/// 利用料金 (Langfuse が計算したもの、USD)。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub today_usd: f64,
    pub month_usd: f64,
    pub month_start: String,
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
        Self { http: reqwest::Client::new(), url, token }
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
        match self.call(reqwest::Method::GET, "/usage", None).await? {
            Some(data) => serde_json::from_value(data).map(Some).map_err(|e| e.to_string()),
            None => Ok(None),
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
