//! stdio MCP サーバーをアプリ (PC) 上で起動し、そのツールを使えるようにする。
//!
//! 設定は Claude Desktop などと同じ形式の mcp.json:
//! { "mcpServers": { "name": { "command": "...", "args": [...], "env": {...} } } }

use std::collections::HashMap;
use std::process::Stdio;

use rmcp::RoleClient;
use rmcp::ServiceExt;
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Deserialize)]
struct McpConfig {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: HashMap<String, ServerConfig>,
}

#[derive(Deserialize)]
struct ServerConfig {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

/// LLM に見せるツール 1 つ分。
pub struct McpTool {
    /// LLM に見せる名前 (`サーバー名__ツール名`。Bedrock の制約に合わせて整形)
    pub exposed_name: String,
    pub description: String,
    pub parameters: Value,
    server: String,
    tool: String,
}

pub struct McpHub {
    clients: HashMap<String, RunningService<RoleClient, ()>>,
    /// 起動したサーバーのプロセス (アプリ終了時に止める)
    children: std::sync::Mutex<Vec<tokio::process::Child>>,
    pub tools: Vec<McpTool>,
}

/// 子プロセスに引き継ぐ環境変数。AWS の認証情報などは渡さない。
const INHERITED_ENV: &[&str] = &[
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "SystemRoot",
    "SystemDrive", "ComSpec", "PATHEXT", "TEMP", "TMP", "LANG",
];

impl McpHub {
    pub fn empty() -> Self {
        Self { clients: HashMap::new(), children: Default::default(), tools: Vec::new() }
    }

    /// 設定ファイルにあるサーバーを起動する。失敗したサーバーは飛ばす。
    pub async fn start(config_path: Option<std::path::PathBuf>) -> Self {
        let mut hub = Self::empty();
        let Some(path) = config_path else { return hub };
        let config: McpConfig = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!("MCP の設定 {} を読めません: {e}", path.display());
                    return hub;
                }
            },
            Err(_) => {
                tracing::info!("MCP の設定ファイルがありません: {}", path.display());
                return hub;
            }
        };

        for (name, server) in config.mcp_servers {
            match connect(&server).await {
                Ok((client, child)) => match client.peer().list_all_tools().await {
                    Ok(tools) => {
                        for tool in tools {
                            hub.tools.push(McpTool {
                                exposed_name: exposed_name(&name, &tool.name),
                                description: tool.description.as_deref().unwrap_or_default().to_string(),
                                parameters: Value::Object((*tool.input_schema).clone()),
                                server: name.clone(),
                                tool: tool.name.to_string(),
                            });
                        }
                        hub.clients.insert(name, client);
                        hub.children.lock().unwrap().push(child);
                    }
                    Err(e) => tracing::warn!("MCP サーバー {name} のツール一覧を取得できません: {e}"),
                },
                Err(e) => tracing::warn!("MCP サーバー {name} を起動できません: {e}"),
            }
        }
        tracing::info!(
            "MCP のツール: {}",
            hub.tools.iter().map(|t| t.exposed_name.as_str()).collect::<Vec<_>>().join(", ")
        );
        hub
    }

    pub fn find(&self, exposed_name: &str) -> Option<&McpTool> {
        self.tools.iter().find(|t| t.exposed_name == exposed_name)
    }

    pub async fn call(&self, tool: &McpTool, args: &Map<String, Value>) -> Result<String, String> {
        let client = self.clients.get(&tool.server).ok_or("MCP サーバーが動いていません")?;
        let mut params = CallToolRequestParams::new(tool.tool.clone());
        params.arguments = Some(args.clone());
        let result = client
            .peer()
            .call_tool(params)
            .await
            .map_err(|e| format!("MCP ツールを実行できません: {e}"))?;
        let text = result
            .content
            .iter()
            .map(|c| match c.as_text() {
                Some(t) => t.text.clone(),
                None => serde_json::to_string(c).unwrap_or_default(),
            })
            .collect::<Vec<_>>()
            .join("\n");
        if result.is_error.unwrap_or(false) { Err(text) } else { Ok(text) }
    }

    /// アプリ終了時に、起動した MCP サーバーのプロセスを止める。
    pub fn kill_all(&self) {
        for child in self.children.lock().unwrap().iter_mut() {
            let _ = child.start_kill();
        }
    }
}

async fn connect(
    server: &ServerConfig,
) -> Result<(RunningService<RoleClient, ()>, tokio::process::Child), String> {
    let mut command = platform_command(&server.command, &server.args);
    command
        .env_clear()
        .envs(INHERITED_ENV.iter().filter_map(|k| std::env::var(k).ok().map(|v| (*k, v))))
        .envs(&server.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| format!("`{}` を起動できません: {e}", server.command))?;
    let (Some(stdout), Some(stdin)) = (child.stdout.take(), child.stdin.take()) else {
        return Err("標準入出力を取得できません".into());
    };
    let client = ().serve((stdout, stdin)).await.map_err(|e| e.to_string())?;
    Ok((client, child))
}

/// Windows では npx などがバッチファイル (.cmd) なので cmd /C 経由で起動し、
/// コンソールウィンドウを出さないようにする。
fn platform_command(program: &str, args: &[String]) -> tokio::process::Command {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = tokio::process::Command::new("cmd");
        command.arg("/C").arg(program).args(args).creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = tokio::process::Command::new(program);
        command.args(args);
        command
    }
}

/// Bedrock のツール名は [a-zA-Z0-9_-]{1,64}。
fn exposed_name(server: &str, tool: &str) -> String {
    format!("{server}__{tool}")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(64)
        .collect()
}
