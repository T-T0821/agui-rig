//! Rig で LLM を呼び出し、ストリームを AG-UI イベントに変換する。

use futures::StreamExt;
use rig_core::DynModel;
use rig_core::completion::{CompletionRequest, Message};
use rig_core::operation::Completion;
use rig_core::streaming::{Item, StreamEvent};

use crate::agui::{Event, RunAgentInput};

const SYSTEM_PROMPT: &str = "あなたは親切なアシスタントです。日本語で簡潔に答えてください。";

/// AG-UI のメッセージ履歴を Rig のリクエストに変換する。
fn to_request(input: &RunAgentInput) -> Option<CompletionRequest> {
    let mut history: Vec<Message> = Vec::new();
    for m in &input.messages {
        let text = m.text();
        if text.trim().is_empty() {
            continue;
        }
        match m.role.as_str() {
            "user" => history.push(Message::user(text)),
            "assistant" => history.push(Message::assistant(text)),
            "system" | "developer" => history.push(Message::system(text)),
            // tool / activity / reasoning などはこのサンプルでは送らない
            _ => {}
        }
    }

    // 最後のメッセージがプロンプト。残りは履歴として前に積む。
    let prompt = history.pop()?;
    let mut preamble = SYSTEM_PROMPT.to_string();
    for c in &input.context {
        preamble.push_str(&format!("\n\n## {}\n{}", c.description, c.value));
    }
    Some(
        CompletionRequest::new(prompt)
            .messages(history)
            .preamble(preamble),
    )
}

/// 1 回分の実行。イベントは `emit` で順に送る。
pub async fn run(
    model: &DynModel<Completion>,
    input: RunAgentInput,
    emit: impl Fn(Event),
) {
    emit(Event::RunStarted {
        thread_id: input.thread_id.clone(),
        run_id: input.run_id.clone(),
    });

    match stream_reply(model, &input, &emit).await {
        Ok(()) => emit(Event::RunFinished {
            thread_id: input.thread_id,
            run_id: input.run_id,
        }),
        Err(message) => emit(Event::RunError { message }),
    }
}

async fn stream_reply(
    model: &DynModel<Completion>,
    input: &RunAgentInput,
    emit: &impl Fn(Event),
) -> Result<(), String> {
    let Some(request) = to_request(input) else {
        return Err("送信するメッセージがありません".into());
    };
    let mut stream = model.stream(request).map_err(|e| e.to_string())?;

    let message_id = uuid::Uuid::new_v4().to_string();
    let mut started = false;

    while let Some(item) = stream.next().await {
        match item.map_err(|e| e.to_string())? {
            Item::Event(StreamEvent::Text { text, .. }) if !text.is_empty() => {
                if !started {
                    emit(Event::TextMessageStart {
                        message_id: message_id.clone(),
                        role: "assistant",
                    });
                    started = true;
                }
                emit(Event::TextMessageContent {
                    message_id: message_id.clone(),
                    delta: text,
                });
            }
            // 推論 (Reasoning) やツール呼び出しはこのサンプルでは表示しない
            _ => {}
        }
    }

    if started {
        emit(Event::TextMessageEnd { message_id });
    }
    Ok(())
}
