//! Rig (Bedrock) のツールループ。ストリームを AG-UI イベントに変換しながら、
//! モデルがツールを呼ばなくなるまで「生成 → ツール実行 → 結果を返す」を繰り返す。

use std::collections::HashMap;
use std::sync::Arc;

use futures::StreamExt;
use tracing::{Instrument, field::Empty};
use rig_core::DynModel;
use rig_core::completion::message::{AssistantContent, AssistantMessage, ToolResultContent};
use rig_core::completion::{CompletionRequest, Message};
use rig_core::operation::Completion;
use rig_core::streaming::{Item, PartKind, StreamEvent};
use rig_core::telemetry::{self as telemetry_content, completion_parent_span};

use crate::agui::{Event, RunAgentInput};
use crate::telemetry;
use crate::history::History;
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
    /// トレースに載せる利用者 ID (ID トークンの sub。メールなどではない不透明な ID)。開発モードでは None。
    /// 利用料金を利用者ごとに集計するキーなので、本文の記録設定に関係なく常に送る
    pub user_id: Option<String>,
    /// チャット履歴の保存先 (CHAT_API_URL 未設定、または未ログインなら None)
    pub history: Option<Arc<History>>,
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
/// トレースでは、この 1 回が Langfuse のトレース 1 本 (セッション = AG-UI のスレッド) になり、
/// その下に Rig のモデル呼び出しとツール呼び出しが並ぶ。
pub async fn run(runtime: &Runtime, input: RunAgentInput, emit: impl Fn(Event)) {
    let content = telemetry::record_content();
    let span = tracing::info_span!(
        "chat",
        langfuse.trace.name = "chat",
        langfuse.observation.type = "agent",
        langfuse.session.id = %input.thread_id,
        langfuse.user.id = runtime.user_id.as_deref(),
        agui.run_id = %input.run_id,
        langfuse.trace.input = Empty,
        langfuse.trace.output = Empty,
        langfuse.observation.level = Empty,
        langfuse.observation.status_message = Empty,
        otel.status_code = Empty,
    );
    if content && let Some(m) = input.messages.iter().rev().find(|m| m.role == "user") {
        span.record("langfuse.trace.input", m.text());
    }

    emit(Event::RunStarted { thread_id: input.thread_id.clone(), run_id: input.run_id.clone() });
    let mut produced = Vec::new();
    let result = run_loop(runtime, &input, &emit, &mut produced).instrument(span.clone()).await;

    // 会話を保存してから終了を知らせる (画面が一覧を読み直したときに反映されているように)。
    // 保存に失敗してもチャット自体は成功扱いにする
    if let Some(history) = &runtime.history {
        let mut messages = input.raw_messages.clone();
        messages.extend(produced);
        if let Err(e) = history.save(&input.thread_id, &messages).instrument(span.clone()).await {
            span.in_scope(|| tracing::warn!("チャット履歴を保存できません: {e}"));
        }
    }

    match result {
        Ok(answer) => {
            if content {
                span.record("langfuse.trace.output", answer);
            }
            emit(Event::RunFinished { thread_id: input.thread_id, run_id: input.run_id });
        }
        Err(message) => {
            span.record("langfuse.observation.level", "ERROR");
            span.record("langfuse.observation.status_message", message.as_str());
            span.record("otel.status_code", "ERROR");
            span.in_scope(|| tracing::warn!("実行に失敗しました: {message}"));
            emit(Event::RunError { message });
        }
    }
}

/// 成功したら最後の回答テキストを返す (トレース用)。
/// この実行で増えたメッセージ (AG-UI の形) は `produced` に足していく (履歴の保存用)。
async fn run_loop(
    runtime: &Runtime,
    input: &RunAgentInput,
    emit: &impl Fn(Event),
    produced: &mut Vec<serde_json::Value>,
) -> Result<String, String> {
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
            .preamble(preamble.clone())
            .record_content_telemetry(telemetry::record_content());
        request.tools = tool_defs.clone();

        // モデル呼び出し 1 回分のスパン。Rig がこのスパンを採用して、モデル名やトークン数を書き込む。
        // ストリームを直接使う場合、入出力の本文は Rig が記録しないので、ここで記録する。
        let content = telemetry::record_content();
        let system = telemetry_content::system_instructions_json(Some(&preamble), content);
        let generation = completion_parent_span!(
            target: "rig_agui_chat_lib::agent",
            name: "chat",
            operation: "chat",
            system_instructions: system.as_deref(),
            langfuse.observation.usage_details = Empty,
        );
        telemetry_content::record_model_input(&generation, &history, content);

        let mut stream = generation.in_scope(|| runtime.model.stream(request).map_err(|e| e.to_string()))?;

        // パート (テキスト / ツール呼び出し) ごとに AG-UI の ID を振る
        let message_id = uuid::Uuid::new_v4().to_string();
        let mut text_open = HashMap::new();
        let mut tool_ids = HashMap::new();
        let mut answer = String::new();

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
                    answer.push_str(&text);
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

        let response = stream.finish().instrument(generation.clone()).await.map_err(|e| e.to_string())?;
        telemetry_content::record_model_output(&generation, &response.choice, content);
        generation.record("langfuse.observation.usage_details", usage_details(&response.usage).as_str());
        drop(generation);
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
            if !answer.is_empty() {
                produced.push(serde_json::json!({ "id": message_id, "role": "assistant", "content": answer }));
            }
            return Ok(answer);
        }

        // ツールを実行して結果を履歴に足し、もう一度モデルを呼ぶ
        history.push(Message::Assistant(AssistantMessage::new(response.choice.clone())));
        let mut results = Vec::new();
        let mut assistant = serde_json::json!({ "id": message_id, "role": "assistant", "toolCalls": [] });
        if !answer.is_empty() {
            assistant["content"] = answer.clone().into();
        }
        let mut tool_messages = Vec::new();
        for (index, call) in calls {
            let name = call.function.name.to_string();
            let output = call_tool(runtime, &input.thread_id, &name, &call.id.to_string(), &call.function.arguments).await;
            let ag_id = tool_ids
                .iter()
                .find(|(part, _)| part.index() == index)
                .map(|(_, id)| id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let result_id = uuid::Uuid::new_v4().to_string();
            assistant["toolCalls"].as_array_mut().unwrap().push(serde_json::json!({
                "id": ag_id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": serde_json::Value::Object(call.function.arguments.clone()).to_string(),
                },
            }));
            tool_messages.push(serde_json::json!({
                "id": result_id, "role": "tool", "toolCallId": ag_id, "content": output,
            }));
            emit(Event::ToolCallResult {
                message_id: result_id,
                tool_call_id: ag_id,
                content: output.clone(),
                role: "tool",
            });
            results.push(call.result(vec![ToolResultContent::text(output)]));
        }
        history.push(Message::tool_results(results));
        produced.push(assistant);
        produced.extend(tool_messages);
    }
    Err(format!("ツールの呼び出しが {MAX_STEPS} 回を超えたので止めました"))
}

/// ツールを 1 つ実行する。失敗はエラー文としてモデルに返す。
/// トレースには GenAI 規約の execute_tool スパンとして載る (Langfuse ではツールとして表示)。
async fn call_tool(runtime: &Runtime, thread_id: &str, name: &str, call_id: &str, args: &serde_json::Map<String, serde_json::Value>) -> String {
    let content = telemetry::record_content();
    let span = tracing::info_span!(
        "execute_tool",
        otel.name = format!("execute_tool {name}"),
        gen_ai.operation.name = "execute_tool",
        gen_ai.tool.name = name,
        gen_ai.tool.call.id = call_id,
        langfuse.observation.type = "tool",
        langfuse.observation.input = Empty,
        langfuse.observation.output = Empty,
        langfuse.observation.level = Empty,
        langfuse.observation.status_message = Empty,
        otel.status_code = Empty,
    );
    if content {
        span.record("langfuse.observation.input", serde_json::Value::Object(args.clone()).to_string());
    }
    let result = runtime.tools.call(thread_id, name, args).instrument(span.clone()).await;
    let output = match result {
        Ok(out) => out,
        Err(e) => {
            span.record("langfuse.observation.level", "ERROR");
            span.record("langfuse.observation.status_message", e.as_str());
            span.record("otel.status_code", "ERROR");
            span.in_scope(|| tracing::warn!("ツール {name} が失敗しました: {e}"));
            format!("エラー: {e}")
        }
    };
    if content {
        span.record("langfuse.observation.output", output.as_str());
    }
    output
}

/// Langfuse の料金計算用に、トークン数を重ならない区分に分けて渡す。
/// Rig の input_tokens はキャッシュの読み書きを含むので、その分を引いたものを `input` にする。
/// Langfuse のモデル定義では、この 4 つのキーに単価を設定する。
fn usage_details(usage: &rig_core::completion::Usage) -> String {
    let cache_read = usage.cached_input_tokens.unwrap_or(0);
    let cache_write = usage.cache_creation_input_tokens.unwrap_or(0);
    let input = usage.input_tokens.unwrap_or(0).saturating_sub(cache_read + cache_write);
    serde_json::json!({
        "input": input,
        "output": usage.output_tokens.unwrap_or(0),
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_write,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::usage_details;
    use rig_core::completion::Usage;

    #[test]
    fn usage_details_splits_cached_input() {
        let mut usage = Usage::default();
        usage.input_tokens = Some(1000);
        usage.output_tokens = Some(50);
        usage.cached_input_tokens = Some(700);
        usage.cache_creation_input_tokens = Some(200);
        let v: serde_json::Value = serde_json::from_str(&usage_details(&usage)).unwrap();
        assert_eq!(v["input"], 100);
        assert_eq!(v["output"], 50);
        assert_eq!(v["cache_read_input_tokens"], 700);
        assert_eq!(v["cache_creation_input_tokens"], 200);
    }
}
