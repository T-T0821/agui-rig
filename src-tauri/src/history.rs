//! チャット履歴 (AppSync → DynamoDB)。
//!
//! AppSync の GraphQL API を、共通基盤の ID トークン (OpenID Connect 認証) で呼ぶ。
//! AppSync がトークンを検証し、リゾルバーがトークンの `sub` だけをパーティションキーに使うので、
//! 利用者は自分の会話にしか届かない。AWS の一時認証情報は使わない。
//! API とテーブルは `infra/chat-history.yaml` (CloudFormation) で作る。
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

    async fn graphql(&self, query: &str, variables: Value) -> Result<Value, String> {
        let response = self
            .http
            .post(&self.url)
            // OpenID Connect 認証: ID トークンをそのまま Authorization に入れる
            .header("Authorization", self.token.get())
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await
            .map_err(|e| format!("チャット履歴の API に接続できません: {e}"))?;
        let status = response.status();
        let body: Value = response.json().await.map_err(|e| format!("チャット履歴の API の応答が不正です ({status}): {e}"))?;
        if let Some(errors) = body.get("errors").and_then(Value::as_array).filter(|e| !e.is_empty()) {
            let messages: Vec<_> = errors.iter().filter_map(|e| e.get("message").and_then(Value::as_str)).collect();
            return Err(format!("チャット履歴の API がエラーを返しました: {}", messages.join(" / ")));
        }
        if !status.is_success() {
            return Err(format!("チャット履歴の API がエラーを返しました ({status})"));
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    }

    /// 会話を保存する (同じ会話は上書き)。`messages` は会話の最初からの全メッセージ。
    pub async fn save(&self, thread_id: &str, messages: &[Value]) -> Result<(), String> {
        if messages.is_empty() {
            return Ok(());
        }
        self.graphql(
            "mutation Save($id: ID!, $title: String!, $messagesGz: String!) {
               saveThread(id: $id, title: $title, messagesGz: $messagesGz) { id }
             }",
            json!({ "id": thread_id, "title": title_of(messages), "messagesGz": encode(messages) }),
        )
        .await?;
        Ok(())
    }

    /// 自分の会話の一覧 (新しい順)。
    pub async fn list(&self) -> Result<Vec<ThreadSummary>, String> {
        let data = self.graphql("query { threads { id title updatedAt } }", json!({})).await?;
        let mut threads: Vec<ThreadSummary> =
            serde_json::from_value(data["threads"].clone()).map_err(|e| e.to_string())?;
        threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(threads)
    }

    /// 会話のメッセージ (AG-UI の形) を古い順に返す。
    pub async fn load(&self, thread_id: &str) -> Result<Vec<Value>, String> {
        let data = self
            .graphql("query Thread($id: ID!) { thread(id: $id) { messagesGz } }", json!({ "id": thread_id }))
            .await?;
        match data["thread"]["messagesGz"].as_str() {
            Some(gz) => decode(gz),
            None => Ok(vec![]),
        }
    }

    /// 会話を消す。
    pub async fn delete(&self, thread_id: &str) -> Result<(), String> {
        self.graphql("mutation Delete($id: ID!) { deleteThread(id: $id) }", json!({ "id": thread_id })).await?;
        Ok(())
    }
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
