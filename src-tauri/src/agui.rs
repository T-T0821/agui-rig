//! AG-UI プロトコル (https://docs.ag-ui.com) の最小限の型定義。
//!
//! フロントの `@ag-ui/client` (HttpAgent) が POST する `RunAgentInput` を受け取り、
//! SSE (`data: {...}`) で AG-UI イベントを返す。
//! 入力は寛容に受け取り (未知のフィールドや新しいメッセージ種別は無視)、
//! 出力はプロトコルどおりの `type` タグ付きイベントにする。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `RunAgentInput`: エージェント実行 1 回分の入力。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAgentInput {
    pub thread_id: String,
    pub run_id: String,
    #[serde(default)]
    pub messages: Vec<InputMessage>,
    /// CopilotKit の `useAgentContext` などで渡される追加コンテキスト。
    #[serde(default)]
    pub context: Vec<ContextItem>,
    // state / tools / forwardedProps も届くが、このサンプルでは使わない。
}

#[derive(Debug, Clone, Deserialize)]
pub struct InputMessage {
    /// "user" | "assistant" | "system" | "developer" | "tool" | "activity" | "reasoning" ...
    pub role: String,
    /// 文字列、または `{ "type": "text", "text": ... }` などの配列。
    #[serde(default)]
    pub content: Value,
}

impl InputMessage {
    /// メッセージ本文のテキスト部分だけを取り出す。
    pub fn text(&self) -> String {
        match &self.content {
            Value::String(s) => s.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ContextItem {
    pub description: String,
    pub value: String,
}

/// フロントへ流す AG-UI イベント (このサンプルで使うものだけ)。
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    RunStarted { thread_id: String, run_id: String },
    TextMessageStart { message_id: String, role: &'static str },
    TextMessageContent { message_id: String, delta: String },
    TextMessageEnd { message_id: String },
    RunFinished { thread_id: String, run_id: String },
    RunError { message: String },
}
