//! Amazon Bedrock AgentCore Code Interpreter をツールとして呼ぶ。
//!
//! チャットのスレッドごとに 1 つのセッションを持つので、同じスレッドの中では
//! 変数や作成したファイルが引き継がれる。

use std::collections::HashMap;

use aws_sdk_bedrockagentcore::Client;
use aws_sdk_bedrockagentcore::types::{
    CodeInterpreterStreamOutput, ProgrammingLanguage, ToolArguments, ToolName,
};
use serde_json::{Map, Value, json};
use tokio::sync::Mutex;

pub const EXECUTE_CODE: &str = "code_interpreter_execute_code";
pub const EXECUTE_COMMAND: &str = "code_interpreter_execute_command";

pub struct CodeInterpreter {
    client: Client,
    /// 既定は AWS マネージドの `aws.codeinterpreter.v1`
    identifier: String,
    /// スレッド ID → セッション ID
    sessions: Mutex<HashMap<String, String>>,
}

impl CodeInterpreter {
    pub fn new(client: Client, identifier: String) -> Self {
        Self { client, identifier, sessions: Mutex::new(HashMap::new()) }
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
        let (tool, arguments) = match name {
            EXECUTE_CODE => {
                let language = match str_arg("language").as_deref() {
                    Some("javascript") => ProgrammingLanguage::Javascript,
                    Some("typescript") => ProgrammingLanguage::Typescript,
                    _ => ProgrammingLanguage::Python,
                };
                let code = str_arg("code").ok_or("code がありません")?;
                (ToolName::ExecuteCode, ToolArguments::builder().code(code).language(language).build())
            }
            EXECUTE_COMMAND => {
                let command = str_arg("command").ok_or("command がありません")?;
                (ToolName::ExecuteCommand, ToolArguments::builder().command(command).build())
            }
            _ => return Err(format!("不明なツール: {name}")),
        };

        // セッションの期限切れなどで失敗したら、新しいセッションで 1 回だけやり直す
        let session = self.session(thread_id, false).await?;
        match self.invoke(&session, tool.clone(), arguments.clone()).await {
            Ok(out) => Ok(out),
            Err(_) => {
                let session = self.session(thread_id, true).await?;
                self.invoke(&session, tool, arguments).await
            }
        }
    }

    async fn session(&self, thread_id: &str, renew: bool) -> Result<String, String> {
        let mut sessions = self.sessions.lock().await;
        if !renew && let Some(id) = sessions.get(thread_id) {
            return Ok(id.clone());
        }
        let started = self
            .client
            .start_code_interpreter_session()
            .code_interpreter_identifier(&self.identifier)
            .name(format!("chat-{}", thread_id.chars().filter(char::is_ascii_alphanumeric).take(40).collect::<String>()))
            .session_timeout_seconds(3600)
            .send()
            .await
            .map_err(|e| format!("Code Interpreter のセッションを開始できません: {}", aws_error(&e)))?;
        let id = started.session_id().to_string();
        sessions.insert(thread_id.to_string(), id.clone());
        Ok(id)
    }

    async fn invoke(&self, session_id: &str, tool: ToolName, arguments: ToolArguments) -> Result<String, String> {
        let mut output = self
            .client
            .invoke_code_interpreter()
            .code_interpreter_identifier(&self.identifier)
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

    /// アプリ終了時などに、開いているセッションを止める。
    pub async fn stop_all(&self) {
        let sessions: Vec<String> = self.sessions.lock().await.drain().map(|(_, v)| v).collect();
        for id in sessions {
            let _ = self
                .client
                .stop_code_interpreter_session()
                .code_interpreter_identifier(&self.identifier)
                .session_id(id)
                .send()
                .await;
        }
    }
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
