mod agent;
mod agui;
mod server;

use std::sync::Arc;

use rig_core::catalog::Catalog;
use serde::Serialize;

/// 既定のモデル。`LLM_MODEL` 環境変数 (`vendor/model` 形式) で上書きできる。
/// API キーはベンダーごとの環境変数 (OPENAI_API_KEY, ANTHROPIC_API_KEY ...) から読まれる。
const DEFAULT_MODEL: &str = "openai/gpt-5.5";

/// フロントが HttpAgent を作るのに必要な接続情報。
#[derive(Clone, Serialize)]
struct AgentEndpoint {
    url: String,
    token: String,
}

/// AG-UI エンドポイントの URL とトークンを返す。
#[tauri::command]
fn agent_endpoint(endpoint: tauri::State<'_, AgentEndpoint>) -> AgentEndpoint {
    endpoint.inner().clone()
}

/// モデル接続・ポート確保・ルーター作成までを行う (Tauri の有無に関係ない部分)。
fn prepare() -> (AgentEndpoint, std::net::TcpListener, axum::Router) {
    let _ = dotenvy::dotenv();

    let model_ref = std::env::var("LLM_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
    let model = Catalog::builtin()
        .connect(model_ref.as_str())
        .map(Arc::new)
        .map_err(|e| format!("モデル {model_ref} に接続できません: {e}"));
    let token = uuid::Uuid::new_v4().to_string();

    // ポートは AGENT_PORT で固定でき、未指定なら空いているポートを使う
    let port: u16 = std::env::var("AGENT_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))
        .expect("AG-UI サーバーのポートを確保できません");
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();

    let endpoint = AgentEndpoint {
        url: format!("http://{addr}/agent"),
        token: token.clone(),
    };
    let app = server::router(server::ServerState { model, token });
    (endpoint, listener, app)
}

async fn serve(listener: std::net::TcpListener, app: axum::Router) {
    let listener = tokio::net::TcpListener::from_std(listener).unwrap();
    axum::serve(listener, app).await.unwrap();
}

/// デスクトップアプリとして起動する。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (endpoint, listener, app) = prepare();

    tauri::Builder::default()
        .manage(endpoint)
        .setup(move |_| {
            tauri::async_runtime::spawn(serve(listener, app));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![agent_endpoint])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// AG-UI サーバーだけを起動する (ウィンドウなし)。
/// `cargo run --example server` で、curl などからバックエンド単体を試せる。
pub async fn run_headless() {
    let (endpoint, listener, app) = prepare();
    println!("AG-UI endpoint: {}", endpoint.url);
    println!("token:          {}", endpoint.token);
    serve(listener, app).await;
}
