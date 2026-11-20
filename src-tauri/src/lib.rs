mod agent;
mod agui;
mod auth;
mod aws;
mod config;
mod history;
mod server;
mod telemetry;
mod tools;

use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use rig_bedrock::client::BedrockRuntime;
use rig_core::DynModel;
use rig_core::catalog::Catalog;
use rig_core::operation::Completion;
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::OnceCell;

use agent::Runtime;
use auth::{OAuthClient, OAuthConfig, Session};
use aws::{AwsSettings, IdToken};
use server::SharedRuntime;
use tools::Tools;
use tools::code_interpreter::CodeInterpreter;
use tools::mcp::McpHub;
use history::{History, ThreadSummary, Usage};

/// 既定のモデル (推論プロファイル ID)。`BEDROCK_MODEL_ID` で上書きできる。
const DEFAULT_MODEL: &str = "global.anthropic.claude-sonnet-5-5";
/// 既定の Code Interpreter (AWS マネージド)。`CODE_INTERPRETER_ID` で上書き、`off` で無効。
const DEFAULT_CODE_INTERPRETER: &str = "aws.codeinterpreter.v1";

struct AppState {
    endpoint: AgentEndpoint,
    aws: AwsSettings,
    /// 共通基盤の OAuth。開発モードと設定エラーのときは None
    oauth: Option<Arc<OAuthClient>>,
    /// ログインなしで、AWS SDK 標準の認証 (AWS_PROFILE / SSO など) を使う開発モード。開発ビルドだけ
    dev_mode: bool,
    /// リリースビルドで OAuth の設定が足りないときの理由 (ログイン画面に出す)
    config_error: Option<String>,
    /// ログイン中のセッション (トークンは Rust 側だけが持つ)
    session: Arc<Mutex<Option<Session>>>,
    /// AG-UI サーバーが使う実行環境 (モデルとツール)
    runtime: SharedRuntime,
    /// 起動時に立ち上げた stdio MCP サーバー
    mcp: Arc<OnceCell<Arc<McpHub>>>,
    refresh_task: Mutex<Option<JoinHandle<()>>>,
}

/// フロントが HttpAgent を作るのに必要な接続情報 (AWS や OAuth のトークンは含まない)。
#[derive(Clone, Serialize)]
struct AgentEndpoint {
    url: String,
    token: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AuthStatus {
    auth_required: bool,
    logged_in: bool,
    user: Option<String>,
}

fn status(state: &AppState) -> AuthStatus {
    let session = state.session.lock().unwrap();
    AuthStatus {
        auth_required: !state.dev_mode,
        logged_in: session.is_some(),
        user: session.as_ref().map(|s| s.user.clone()),
    }
}

/// 認証情報からモデルとツールを組み立てる。
/// `user_id` は ID トークンの sub (開発モードでは None)。トレースの利用者 ID になる。
async fn build_runtime(
    state: &AppState,
    token: Option<(IdToken, String)>,
    user_id: Option<String>,
) -> Result<Arc<Runtime>, String> {
    // チャット履歴 (AppSync)。ID トークンで認証するので、ログインしているときだけ。CHAT_API_URL が無ければ保存しない
    let history = std::env::var("CHAT_API_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
        .zip(token.as_ref().map(|(t, _)| t.clone()))
        .map(|(url, token)| Arc::new(History::new(url, token)));
    let config = aws::sdk_config(&state.aws, token).await?;

    // 動作確認用: LLM_MODEL (vendor/model 形式、例: anthropic/claude-sonnet-5-5) があれば
    // Bedrock ではなくそのプロバイダーを使う。API キーは ANTHROPIC_API_KEY などから読まれる。
    // LLM_MODEL は開発ビルドだけ (配布物では必ず Bedrock を使う)
    let test_model = std::env::var("LLM_MODEL").ok().filter(|s| cfg!(debug_assertions) && !s.is_empty());
    let model: DynModel<Completion> = match &test_model {
        Some(reference) => Catalog::builtin()
            .connect(reference.as_str())
            .map_err(|e| format!("モデル {reference} に接続できません: {e}"))?,
        None => {
            let model_id = std::env::var("BEDROCK_MODEL_ID").unwrap_or_else(|_| DEFAULT_MODEL.into());
            BedrockRuntime::from(aws_sdk_bedrockruntime::Client::new(&config)).completion(model_id).into()
        }
    };

    // Code Interpreter は AWS のサービス。LLM_MODEL を使い、かつ OAuth も無い (AWS の認証が無いことが多い)
    // ときは、CODE_INTERPRETER_ID を明示しない限り無効にする
    let ci_default = if test_model.is_some() && state.dev_mode { "off" } else { DEFAULT_CODE_INTERPRETER };
    let ci_id = std::env::var("CODE_INTERPRETER_ID").unwrap_or_else(|_| ci_default.into());
    let code_interpreter = (ci_id != "off")
        .then(|| Arc::new(CodeInterpreter::new(aws_sdk_bedrockagentcore::Client::new(&config), ci_id)));

    let mcp = state.mcp.get_or_init(|| async { Arc::new(McpHub::empty()) }).await.clone();
    Ok(Arc::new(Runtime { model: Arc::new(model), tools: Tools { code_interpreter, mcp }, user_id, history }))
}

/// 実行環境を差し替える。古い Code Interpreter のセッションは止める。
fn replace_runtime(runtime: &SharedRuntime, next: Option<Arc<Runtime>>) {
    let old = std::mem::replace(&mut *runtime.write().unwrap(), next);
    if let Some(ci) = old.and_then(|r| r.tools.code_interpreter.clone()) {
        tauri::async_runtime::spawn(async move { ci.stop_all().await });
    }
}

fn history_of(state: &AppState) -> Option<Arc<History>> {
    state.runtime.read().unwrap().as_ref().and_then(|r| r.history.clone())
}

#[derive(Serialize)]
struct ThreadList {
    /// 履歴が使えるか (CHAT_API_URL が設定されていて、ログイン済み)
    enabled: bool,
    threads: Vec<ThreadSummary>,
}

/// 自分の過去の会話の一覧。
#[tauri::command]
async fn list_threads(state: State<'_, AppState>) -> Result<ThreadList, String> {
    match history_of(&state) {
        Some(h) => Ok(ThreadList { enabled: true, threads: h.list().await? }),
        None => Ok(ThreadList { enabled: false, threads: vec![] }),
    }
}

/// 会話のメッセージ (AG-UI の形) を読み込む。
#[tauri::command]
async fn load_thread(state: State<'_, AppState>, thread_id: String) -> Result<Vec<serde_json::Value>, String> {
    history_of(&state).ok_or("チャット履歴は無効です")?.load(&thread_id).await
}

/// 自分の利用料金 (今日と今月)。使えなければ None。
#[tauri::command]
async fn usage_summary(state: State<'_, AppState>) -> Result<Option<Usage>, String> {
    match history_of(&state) {
        Some(h) => h.usage().await,
        None => Ok(None),
    }
}

#[tauri::command]
async fn delete_thread(state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    history_of(&state).ok_or("チャット履歴は無効です")?.delete(&thread_id).await
}

#[tauri::command]
fn agent_endpoint(state: State<'_, AppState>) -> AgentEndpoint {
    state.endpoint.clone()
}

#[tauri::command]
fn auth_status(state: State<'_, AppState>) -> AuthStatus {
    status(&state)
}

/// 共通基盤の OAuth でログインし、ID トークン → STS の一時認証情報で Bedrock などを使えるようにする。
#[tauri::command]
async fn login(app: AppHandle, state: State<'_, AppState>) -> Result<AuthStatus, String> {
    let oauth = state
        .oauth
        .clone()
        .ok_or_else(|| state.config_error.clone().unwrap_or_else(|| "OAuth が設定されていません".into()))?;
    let session = oauth
        .login(|url| {
            tracing::info!("ブラウザでログインしてください: {url}");
            if let Err(e) = app.opener().open_url(url, None::<&str>) {
                tracing::warn!("ブラウザを開けません: {e}");
            }
        })
        .await?;
    let id_token = IdToken::new(session.id_token.clone());
    let runtime = build_runtime(&state, Some((id_token.clone(), session.principal.clone())), Some(session.sub.clone())).await?;
    replace_runtime(&state.runtime, Some(runtime));
    *state.session.lock().unwrap() = Some(session);
    start_refresh(&app, &state, id_token);
    Ok(status(&state))
}

#[tauri::command]
fn logout(state: State<'_, AppState>) -> AuthStatus {
    if let Some(task) = state.refresh_task.lock().unwrap().take() {
        task.abort();
    }
    *state.session.lock().unwrap() = None;
    replace_runtime(&state.runtime, None);
    status(&state)
}

/// ID トークンの期限前に、リフレッシュトークンで更新し続ける。
/// 新しい ID トークンは、次に STS を呼ぶとき (一時認証情報の期限前) に使われる。
/// 更新できなければログアウト扱いにして、フロントに知らせる。
fn start_refresh(app: &AppHandle, state: &AppState, id_token: IdToken) {
    let Some(oauth) = state.oauth.clone() else { return };
    let (session, runtime, app) = (state.session.clone(), state.runtime.clone(), app.clone());
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let Some(current) = session.lock().unwrap().clone() else { return };
            tokio::time::sleep(current.refresh_in()).await;
            match oauth.refresh(&current).await {
                Ok(next) => {
                    id_token.set(next.id_token.clone());
                    *session.lock().unwrap() = Some(next);
                }
                Err(e) => {
                    tracing::warn!("トークンを更新できません。再ログインが必要です: {e}");
                    *session.lock().unwrap() = None;
                    replace_runtime(&runtime, None);
                    let _ = app.emit("auth-changed", ());
                    return;
                }
            }
        }
    });
    if let Some(old) = state.refresh_task.lock().unwrap().replace(task) {
        old.abort();
    }
}

/// ログインの方式。
struct AuthMode {
    oauth: Option<OAuthConfig>,
    dev_mode: bool,
    error: Option<String>,
}

impl AuthMode {
    /// 開発ビルド: `DEV_SKIP_LOGIN=1` か OAUTH_ISSUER 未設定なら開発モード (ログインなし)。
    /// リリースビルド: 開発モードは無く、https の OAUTH_ISSUER が必須 (模擬サーバーにも向けられない)。
    fn resolve() -> Self {
        let config = OAuthConfig::from_env();
        if cfg!(debug_assertions) {
            let skip = std::env::var("DEV_SKIP_LOGIN").is_ok_and(|v| matches!(v.as_str(), "1" | "true" | "yes"));
            return if skip || config.is_none() {
                Self { oauth: None, dev_mode: true, error: None }
            } else {
                Self { oauth: config, dev_mode: false, error: None }
            };
        }
        match config {
            Some(c) if c.issuer.starts_with("https://") => Self { oauth: Some(c), dev_mode: false, error: None },
            Some(_) => Self { oauth: None, dev_mode: false, error: Some("OAUTH_ISSUER は https:// で始まる必要があります".into()) },
            None => Self { oauth: None, dev_mode: false, error: Some("OAUTH_ISSUER が設定されていません".into()) },
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 設定 (環境変数 / .env、アプリ設定フォルダの config.json、ビルド時の設定) を読む
    let loaded = config::load();
    telemetry::init();
    for note in loaded.notes {
        tracing::info!("設定: {note}");
    }

    // AG-UI サーバー: ポートは AGENT_PORT で固定でき、未指定なら空いているポート
    let port: u16 = std::env::var("AGENT_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).expect("AG-UI サーバーのポートを確保できません");
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let token = uuid::Uuid::new_v4().to_string();
    let runtime: SharedRuntime = Arc::new(RwLock::new(None));
    let app_router = server::router(server::ServerState { runtime: runtime.clone(), token: token.clone() });

    let auth_mode = AuthMode::resolve();
    if let Some(e) = &auth_mode.error {
        tracing::error!("{e}");
    } else if auth_mode.dev_mode {
        tracing::warn!("開発モード: ログインせず、AWS SDK 標準の認証 (AWS_PROFILE / SSO など) を使います");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            app.manage(AppState {
                endpoint: AgentEndpoint { url: format!("http://{addr}/agent"), token },
                aws: AwsSettings::from_env(),
                oauth: auth_mode.oauth.map(|c| Arc::new(OAuthClient::new(c))),
                dev_mode: auth_mode.dev_mode,
                config_error: auth_mode.error,
                session: Arc::new(Mutex::new(None)),
                runtime,
                mcp: Arc::new(OnceCell::new()),
                refresh_task: Mutex::new(None),
            });

            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                axum::serve(listener, app_router).await.unwrap();
            });

            // stdio MCP サーバーを起動する。設定は MCP_CONFIG、なければアプリの設定フォルダの mcp.json
            let handle = app.handle().clone();
            let mcp_path = std::env::var("MCP_CONFIG")
                .map(Into::into)
                .ok()
                .or_else(|| app.path().app_config_dir().ok().map(|d| d.join("mcp.json")));
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let hub = Arc::new(McpHub::start(mcp_path).await);
                let _ = state.mcp.set(hub);
                // OAuth を使わない開発モードでは、AWS SDK 標準の認証ですぐ使えるようにする
                if state.dev_mode {
                    match build_runtime(&state, None, None).await {
                        Ok(rt) => replace_runtime(&state.runtime, Some(rt)),
                        Err(e) => tracing::warn!("{e}"),
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_endpoint,
            auth_status,
            login,
            logout,
            list_threads,
            load_thread,
            delete_thread,
            usage_summary
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // ここまでのトレースを送り切る
                let _ = std::thread::spawn(telemetry::shutdown).join();
                // MCP サーバーのプロセスと Code Interpreter のセッションを止める (最大 3 秒待つ)
                if let Some(hub) = app.state::<AppState>().mcp.get() {
                    hub.kill_all();
                }
                let runtime = app.state::<AppState>().runtime.write().unwrap().take();
                if let Some(ci) = runtime.and_then(|r| r.tools.code_interpreter.clone()) {
                    tauri::async_runtime::block_on(async {
                        let _ = tokio::time::timeout(Duration::from_secs(3), ci.stop_all()).await;
                    });
                }
            }
        });
}
