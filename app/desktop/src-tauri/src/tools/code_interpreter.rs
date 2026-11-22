//! Amazon Bedrock AgentCore Code Interpreter をツールとして呼ぶ。
//!
//! チャットのスレッドごとに 1 つのセッションを持つので、同じスレッドの中では
//! 変数や作成したファイルが引き継がれる。
//!
//! 呼び方は 2 通り:
//! - ログイン中 (本番): バックエンドの LLM プロキシ経由 (`POST {CHAT_API_URL}/v1/code-interpreter/invoke`、ID トークンで認証)。
//!   アプリは AWS の認証情報を持たない。どの Code Interpreter を使うかと、セッションが本人のものかはプロキシが決める
//! - 開発モード (`pnpm dev:aws`): 開発者自身の AWS 認証で AgentCore を直接呼ぶ

use std::collections::HashMap;

use aws_sdk_bedrockagentcore::Client;
use aws_sdk_bedrockagentcore::types::{
    CodeInterpreterStreamOutput, ProgrammingLanguage, ToolArguments, ToolName,
};
use serde_json::{Map, Value, json};
use tokio::sync::Mutex;

use crate::auth::IdToken;

pub const EXECUTE_CODE: &str = "code_interpreter_execute_code";
pub const EXECUTE_COMMAND: &str = "code_interpreter_execute_command";

enum Backend {
    /// 開発モード: AgentCore を直接呼ぶ。identifier の既定は AWS マネージドの `aws.codeinterpreter.v1`
    Direct { client: Client, identifier: String },
    /// ログイン中: プロキシ経由 (`{CHAT_API_URL}/v1/code-interpreter`)
    Proxy { http: reqwest::Client, url: String, token: IdToken },
}

pub struct CodeInterpreter {
    backend: Backend,
    /// スレッド ID → セッション ID
    sessions: Mutex<HashMap<String, String>>,
}

/// 実行するもの (AgentCore の executeCode / executeCommand)
#[derive(Clone)]
enum Call {
    Code { code: String, language: &'static str },
    Command { command: String },
}

impl CodeInterpreter {
    /// 開発モード: AgentCore を直接呼ぶ。
    pub fn direct(client: Client, identifier: String) -> Self {
        Self { backend: Backend::Direct { client, identifier }, sessions: Mutex::new(HashMap::new()) }
    }

    /// ログイン中: プロキシ経由で呼ぶ。`api_url` は CHAT_API_URL。
    pub fn proxy(api_url: &str, token: IdToken) -> Self {
        let url = format!("{}/v1/code-interpreter", api_url.trim_end_matches('/'));
        Self { backend: Backend::Proxy { http: reqwest::Client::new(), url, token }, sessions: Mutex::new(HashMap::new()) }
    }

    pub fn definitions() -> Vec<(&'static str, &'static str, Value)> {
        vec![
            (
                EXECUTE_CODE,
                "隔離されたサンドボックス (AWS の Code Interpreter) でコードを実行し、標準出力・標準エラー・終了コードを返す。\
                 計算、データ処理、グラフ作成などに使う。同じ会話の中では変数やファイルが引き継がれる。",
                json!({
                    "type": "object",
                    "properties": {
                        "code": { "type": "string", "description": "実行するコード" },
                        "language": {
                            "type": "string",
                            "enum": ["python", "javascript", "typescript"],
                            "description": "言語 (既定は python)"
                        }
                    },
                    "required": ["code"]
                }),
            ),
            (
                EXECUTE_COMMAND,
                "Code Interpreter のサンドボックス内でシェルコマンドを実行する (pip install、ファイル一覧など)。",
                json!({
                    "type": "object",
                    "properties": { "command": { "type": "string", "description": "実行するコマンド" } },
                    "required": ["command"]
                }),
            ),
        ]
    }

    pub async fn call(&self, thread_id: &str, name: &str, args: &Map<String, Value>) -> Result<String, String> {
        let str_arg = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_string);
        let call = match name {
            EXECUTE_CODE => {
                let language = match str_arg("language").as_deref() {
                    Some("javascript") => "javascript",
                    Some("typescript") => "typescript",
                    _ => "python",
                };
                Call::Code { code: str_arg("code").ok_or("code がありません")?, language }
            }
            EXECUTE_COMMAND => Call::Command { command: str_arg("command").ok_or("command がありません")? },
            _ => return Err(format!("不明なツール: {name}")),
        };
        match &self.backend {
            Backend::Direct { client, identifier } => self.call_direct(client, identifier, thread_id, call).await,
            Backend::Proxy { http, url, token } => self.call_proxy(http, url, token, thread_id, call).await,
        }
    }

    // ---- プロキシ経由 ----

    /// プロキシは、渡したセッションが本人のものでまだ使えればそれを使い、無ければ新しく作ってその ID を返す
    /// (期限切れのやり直しもプロキシが行う)。
    async fn call_proxy(&self, http: &reqwest::Client, url: &str, token: &IdToken, thread_id: &str, call: Call) -> Result<String, String> {
        let session = self.sessions.lock().await.get(thread_id).cloned();
        let (tool, arguments) = match call {
            Call::Code { code, language } => ("executeCode", json!({ "code": code, "language": language })),
            Call::Command { command } => ("executeCommand", json!({ "command": command })),
        };
        let body = json!({ "threadId": thread_id, "sessionId": session, "tool": tool, "arguments": arguments });
        let response = http
            .post(format!("{url}/invoke"))
            .bearer_auth(token.get())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Code Interpreter (プロキシ) に接続できません: {e}"))?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|e| format!("Code Interpreter (プロキシ) の応答を読めません ({status}): {e}"))?;
        if !status.is_success() {
            let message = value.pointer("/error/message").or_else(|| value.get("message")).and_then(Value::as_str).unwrap_or("");
            return Err(format!("Code Interpreter (プロキシ) がエラーを返しました ({status}) {message}").trim_end().to_owned());
        }
        if let Some(id) = value.get("sessionId").and_then(Value::as_str) {
            self.sessions.lock().await.insert(thread_id.to_string(), id.to_string());
        }
        Ok(json!({ "isError": value["isError"], "output": value["output"], "result": value["result"] }).to_string())
    }

    // ---- 直接 (開発モード) ----

    async fn call_direct(&self, client: &Client, identifier: &str, thread_id: &str, call: Call) -> Result<String, String> {
        let (tool, arguments) = match call {
            Call::Code { code, language } => {
                let language = match language {
                    "javascript" => ProgrammingLanguage::Javascript,
                    "typescript" => ProgrammingLanguage::Typescript,
                    _ => ProgrammingLanguage::Python,
                };
                (ToolName::ExecuteCode, ToolArguments::builder().code(code).language(language).build())
            }
            Call::Command { command } => (ToolName::ExecuteCommand, ToolArguments::builder().command(command).build()),
        };

        // セッションの期限切れなどで失敗したら、新しいセッションで 1 回だけやり直す
        let session = self.session(client, identifier, thread_id, false).await?;
        match invoke(client, identifier, &session, tool.clone(), arguments.clone()).await {
            Ok(out) => Ok(out),
            Err(_) => {
                let session = self.session(client, identifier, thread_id, true).await?;
                invoke(client, identifier, &session, tool, arguments).await
            }
        }
    }

    async fn session(&self, client: &Client, identifier: &str, thread_id: &str, renew: bool) -> Result<String, String> {
        let mut sessions = self.sessions.lock().await;
        if !renew && let Some(id) = sessions.get(thread_id) {
            return Ok(id.clone());
        }
        let started = client
            .start_code_interpreter_session()
            .code_interpreter_identifier(identifier)
            .name(format!("chat-{}", thread_id.chars().filter(char::is_ascii_alphanumeric).take(40).collect::<String>()))
            .session_timeout_seconds(3600)
            .send()
            .await
            .map_err(|e| format!("Code Interpreter のセッションを開始できません: {}", aws_error(&e)))?;
        let id = started.session_id().to_string();
        sessions.insert(thread_id.to_string(), id.clone());
        Ok(id)
    }

    /// アプリ終了時などに、開いているセッションを止める。
    pub async fn stop_all(&self) {
        let sessions: Vec<String> = self.sessions.lock().await.drain().map(|(_, v)| v).collect();
        for id in sessions {
            match &self.backend {
                Backend::Direct { client, identifier } => {
                    let _ = client.stop_code_interpreter_session().code_interpreter_identifier(identifier).session_id(id).send().await;
                }
                Backend::Proxy { http, url, token } => {
                    let _ = http.post(format!("{url}/stop")).bearer_auth(token.get()).json(&json!({ "sessionId": id })).send().await;
                }
            }
        }
    }
}

async fn invoke(client: &Client, identifier: &str, session_id: &str, tool: ToolName, arguments: ToolArguments) -> Result<String, String> {
    let mut output = client
        .invoke_code_interpreter()
        .code_interpreter_identifier(identifier)
        .session_id(session_id)
        .name(tool)
        .arguments(arguments)
        .send()
        .await
        .map_err(|e| format!("Code Interpreter を呼べません: {}", aws_error(&e)))?;

    let mut texts = Vec::new();
    let mut structured = None;
    let mut is_error = false;
    while let Some(event) = output.stream.recv().await.map_err(|e| format!("Code Interpreter の応答を読めません: {}", aws_error(&e)))? {
        if let CodeInterpreterStreamOutput::Result(result) = event {
            is_error |= result.is_error().unwrap_or(false);
            texts.extend(result.content().iter().filter_map(|c| c.text().map(str::to_string)));
            if let Some(s) = result.structured_content() {
                structured = Some(json!({
                    "stdout": s.stdout(),
                    "stderr": s.stderr(),
                    "exitCode": s.exit_code(),
                    "executionTime": s.execution_time(),
                }));
            }
        }
    }
    Ok(json!({ "isError": is_error, "output": texts.join("\n"), "result": structured }).to_string())
}

/// AWS SDK のエラーを、原因までつなげた文字列にする (SdkError の表示は短すぎるため)。
fn aws_error(e: &(dyn std::error::Error + 'static)) -> String {
    let mut message = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        message.push_str(&format!(": {s}"));
        source = s.source();
    }
    message
}
