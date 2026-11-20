//! Rig (Bedrock) のツールループ。ストリームを AG-UI イベントに変換しながら、
//! モデルがツールを呼ばなくなるまで「生成 → ツール実行 → 結果を返す」を繰り返す。

use std::collections::HashMap;
use std::sync::Arc;

use futures::StreamExt;
use rig_core::DynModel;
use rig_core::completion::message::{AssistantContent, AssistantMessage, ToolResultContent};
use rig_core::completion::{CompletionRequest, Message};
use rig_core::operation::Completion;
use rig_core::streaming::{Item, PartKind, StreamEvent};

use crate::agui::{Event, RunAgentInput};
use crate::tools::Tools;

const SYSTEM_PROMPT: &str = "あなたは親切なアシスタントです。日本語で簡潔に答えてください。\
計算・データ処理・コードの実行が必要なときは Code Interpreter を、\
PC 上のツールが必要なときは MCP のツールを使ってください。";

/// 1 回の実行でツールを呼べる回数の上限 (無限ループ防止)。
const MAX_STEPS: usize = 10;

/// 1 回分の実行に必要なもの。
pub struct Runtime {
    pub model: Arc<DynModel<Completion>>,
    pub tools: Tools,
}

/// AG-UI のメッセージ履歴を Rig のメッセージに変換する。
/// 過去のターンのツール呼び出しと結果は、テキストとして要約して渡す
/// (プロバイダーごとのツール ID の整合を気にしなくて済むように)。
/// Bedrock は同じ役割が続くメッセージを受け付けないので、隣り合う同じ役割はまとめる。
fn to_history(input: &RunAgentInput) -> Vec<Message> {
    let mut turns: Vec<(&'static str, String)> = Vec::new();
    for m in &input.messages {
        let (role, text) = match m.role.as_str() {
            "user" => ("user", m.text()),
            "assistant" => {
                let mut text = m.text();
                for call in &m.tool_calls {
                    text.push_str(&format!(
                        "\n[ツール {} を呼び出し: {}]",
                        call.function.name, call.function.arguments
                    ));
                }
                ("assistant", text)
            }
            "tool" => ("assistant", format!("[ツールの結果: {}]", m.text())),
            _ => continue, // system / developer はプリアンブルに入れる
        };
        if text.trim().is_empty() {
            continue;
        }
        match turns.last_mut() {
            Some((last, buf)) if *last == role => {
                buf.push('\n');
                buf.push_str(&text);
            }
            _ => turns.push((role, text)),
        }
    }
    turns
        .into_iter()
        .map(|(role, text)| if role == "user" { Message::user(text) } else { Message::assistant(text) })
        .collect()
}

fn preamble(input: &RunAgentInput) -> String {
    let mut preamble = SYSTEM_PROMPT.to_string();
    for m in &input.messages {
        if matches!(m.role.as_str(), "system" | "developer") && !m.text().trim().is_empty() {
            preamble.push_str("\n\n");
            preamble.push_str(&m.text());
        }
    }
    for c in &input.context {
        preamble.push_str(&format!("\n\n## {}\n{}", c.description, c.value));
    }
    preamble
}

/// 1 回分の実行。イベントは `emit` で順に送る。
pub async fn run(runtime: &Runtime, input: RunAgentInput, emit: impl Fn(Event)) {
    emit(Event::RunStarted { thread_id: input.thread_id.clone(), run_id: input.run_id.clone() });
    match run_loop(runtime, &input, &emit).await {
        Ok(()) => emit(Event::RunFinished { thread_id: input.thread_id, run_id: input.run_id }),
        Err(message) => emit(Event::RunError { message }),
    }
}

async fn run_loop(runtime: &Runtime, input: &RunAgentInput, emit: &impl Fn(Event)) -> Result<(), String> {
    let mut history = to_history(input);
    if !matches!(history.last(), Some(Message::User { .. })) {
        return Err("送信するメッセージがありません".into());
    }
    let preamble = preamble(input);
    let tool_defs: Vec<_> = runtime.tools.definitions().into_iter().map(Arc::new).collect();

    for _ in 0..MAX_STEPS {
        let prompt = history.last().cloned().unwrap();
        let mut request = CompletionRequest::new(prompt)
            .messages(history[..history.len() - 1].iter().cloned())
            .preamble(preamble.clone());
        request.tools = tool_defs.clone();

        let mut stream = runtime.model.stream(request).map_err(|e| e.to_string())?;

        // パート (テキスト / ツール呼び出し) ごとに AG-UI の ID を振る
        let message_id = uuid::Uuid::new_v4().to_string();
        let mut text_open = HashMap::new();
        let mut tool_ids = HashMap::new();

        while let Some(item) = stream.next().await {
            let Item::Event(event) = item.map_err(|e| e.to_string())? else { continue };
            match event {
                StreamEvent::Start { part, kind: PartKind::ToolCall, name } => {
                    let id = uuid::Uuid::new_v4().to_string();
                    emit(Event::ToolCallStart {
                        tool_call_id: id.clone(),
                        tool_call_name: name.map(|n| n.to_string()).unwrap_or_default(),
                        parent_message_id: message_id.clone(),
                    });
                    tool_ids.insert(part, id);
                }
                StreamEvent::Arguments { part, json } if !json.is_empty() => {
                    if let Some(id) = tool_ids.get(&part) {
                        emit(Event::ToolCallArgs { tool_call_id: id.clone(), delta: json });
                    }
                }
                StreamEvent::Text { part, text } if !text.is_empty() => {
                    if text_open.insert(part, ()).is_none() {
                        emit(Event::TextMessageStart { message_id: message_id.clone(), role: "assistant" });
                    }
                    emit(Event::TextMessageContent { message_id: message_id.clone(), delta: text });
                }
                StreamEvent::End { part, .. } => {
                    if let Some(id) = tool_ids.get(&part) {
                        emit(Event::ToolCallEnd { tool_call_id: id.clone() });
                    } else if text_open.contains_key(&part) {
                        emit(Event::TextMessageEnd { message_id: message_id.clone() });
                    }
                }
                _ => {}
            }
        }

        let response = stream.finish().await.map_err(|e| e.to_string())?;
        let calls: Vec<_> = response
            .choice
            .iter()
            .enumerate()
            .filter_map(|(i, c)| match c {
                AssistantContent::ToolCall(call) => Some((i, call.clone())),
                _ => None,
            })
            .collect();
        if calls.is_empty() {
            return Ok(());
        }

        // ツールを実行して結果を履歴に足し、もう一度モデルを呼ぶ
        history.push(Message::Assistant(AssistantMessage::new(response.choice.clone())));
        let mut results = Vec::new();
        for (index, call) in calls {
            let name = call.function.name.to_string();
            let output = match runtime.tools.call(&input.thread_id, &name, &call.function.arguments).await {
                Ok(out) => out,
                Err(e) => format!("エラー: {e}"),
            };
            let ag_id = tool_ids
                .iter()
                .find(|(part, _)| part.index() == index)
                .map(|(_, id)| id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            emit(Event::ToolCallResult {
                message_id: uuid::Uuid::new_v4().to_string(),
                tool_call_id: ag_id,
                content: output.clone(),
                role: "tool",
            });
            results.push(call.result(vec![ToolResultContent::text(output)]));
        }
        history.push(Message::tool_results(results));
    }
    Err(format!("ツールの呼び出しが {MAX_STEPS} 回を超えたので止めました"))
}
