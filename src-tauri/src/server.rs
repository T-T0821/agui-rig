//! Tauri アプリ内で動くローカル HTTP サーバー (AG-UI エンドポイント)。
//!
//! `POST /agent` に `RunAgentInput` を送ると、AG-UI イベントを SSE で返す。
//! フロントの `HttpAgent` (@ag-ui/client) がそのまま接続できる。

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use rig_core::DynModel;
use rig_core::operation::Completion;
use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tower_http::cors::CorsLayer;

use crate::agent;
use crate::agui::{Event, RunAgentInput};

#[derive(Clone)]
pub struct ServerState {
    /// 起動時に接続したモデル。失敗した場合はエラーメッセージ。
    pub model: Result<Arc<DynModel<Completion>>, String>,
    /// 起動ごとに生成するトークン。同じ PC 上の他のアプリや
    /// ブラウザのページからエンドポイントを叩かれないようにする。
    pub token: String,
}

pub fn router(state: ServerState) -> Router {
    Router::new()
        .route("/agent", post(run_agent))
        // WebView のオリジン (http://localhost:1420, tauri://localhost など) から呼べるように
        .layer(CorsLayer::very_permissive())
        .with_state(state)
}

async fn run_agent(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(input): Json<RunAgentInput>,
) -> Response {
    let authorized = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == format!("Bearer {}", state.token));
    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let (tx, rx) = mpsc::unbounded_channel::<Event>();

    tokio::spawn(async move {
        let emit = |event: Event| {
            let _ = tx.send(event);
        };
        match &state.model {
            Ok(model) => {
                // クライアントが切断したら (停止ボタンなど) LLM のストリームも止める
                tokio::select! {
                    _ = agent::run(model, input, emit) => {}
                    _ = tx.closed() => {}
                }
            }
            Err(message) => {
                emit(Event::RunStarted {
                    thread_id: input.thread_id.clone(),
                    run_id: input.run_id.clone(),
                });
                emit(Event::RunError { message: message.clone() });
            }
        }
    });

    let stream = UnboundedReceiverStream::new(rx).map(|event| {
        Ok::<_, Infallible>(SseEvent::default().data(serde_json::to_string(&event).unwrap()))
    });
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}
