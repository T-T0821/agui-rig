//! エージェントが使えるツール (Code Interpreter と stdio MCP) をまとめる。

pub mod code_interpreter;
pub mod mcp;

use std::sync::Arc;

use rig_core::completion::ToolDefinition;
use rig_core::completion::message::ToolName;
use serde_json::{Map, Value};

use code_interpreter::CodeInterpreter;
use mcp::McpHub;

#[derive(Clone)]
pub struct Tools {
    pub code_interpreter: Option<Arc<CodeInterpreter>>,
    pub mcp: Arc<McpHub>,
}

impl Tools {
    pub fn definitions(&self) -> Vec<ToolDefinition> {
        let mut defs = Vec::new();
        if self.code_interpreter.is_some() {
            for (name, description, parameters) in CodeInterpreter::definitions() {
                defs.push(definition(name, description, parameters));
            }
        }
        for tool in &self.mcp.tools {
            defs.push(definition(&tool.exposed_name, &tool.description, tool.parameters.clone()));
        }
        defs
    }

    /// ツールを実行する。結果は LLM に返す文字列。
    pub async fn call(&self, thread_id: &str, name: &str, args: &Map<String, Value>) -> Result<String, String> {
        if name.starts_with("code_interpreter_") {
            let ci = self.code_interpreter.as_ref().ok_or("Code Interpreter は無効です")?;
            return ci.call(thread_id, name, args).await;
        }
        let tool = self.mcp.find(name).ok_or_else(|| format!("不明なツール: {name}"))?;
        self.mcp.call(tool, args).await
    }
}

fn definition(name: &str, description: &str, parameters: Value) -> ToolDefinition {
    ToolDefinition {
        name: ToolName::new(name).expect("ツール名が空です"),
        description: description.to_string(),
        parameters,
        annotations: Default::default(),
    }
}
