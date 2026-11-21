// `npm run dev:mock` と E2E テスト (e2e/) が共通で使う、模擬サーバー向けの設定。

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

/** 動作確認用の stdio MCP サーバー (時刻ツール) の設定を一時ファイルに書く。 */
export function exampleMcpConfig() {
  const dir = join(root, "examples", "time-mcp");
  if (!existsSync(join(dir, "node_modules"))) {
    console.error("[dev] 例の MCP サーバーの依存をインストールします…");
    spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit", shell: isWindows });
  }
  const path = join(mkdtempSync(join(tmpdir(), "rig-agui-dev-")), "mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { time: { command: "node", args: [join(dir, "server.mjs")] } } }, null, 2));
  return path;
}

/**
 * アプリの環境変数を全部、模擬サーバー (`base`) に向ける。
 * 環境変数は .env や config.json より優先されるので、ここで全部を上書きする。
 */
export function mockEnv(base) {
  const noProxy = ["127.0.0.1", "localhost", process.env.NO_PROXY].filter(Boolean).join(",");
  return {
    OAUTH_ISSUER: base,
    OAUTH_CLIENT_ID: "chat-app",
    DEV_SKIP_LOGIN: "",
    AWS_REGION: "ap-northeast-1",
    AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/mock-chat",
    AWS_ENDPOINT_URL_STS: base,
    AWS_ENDPOINT_URL_BEDROCK_RUNTIME: base,
    AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: base,
    BEDROCK_MODEL_ID: "global.anthropic.claude-sonnet-5-5",
    CODE_INTERPRETER_ID: "aws.codeinterpreter.v1",
    LLM_MODEL: "",
    MCP_CONFIG: exampleMcpConfig(),
    CHAT_API_URL: `${base}/api`,
    // トレースは本番と同じく Collector へ、ID トークンで認証して送る (Langfuse のキーはアプリに渡さない)
    LANGFUSE_PUBLIC_KEY: "",
    LANGFUSE_SECRET_KEY: "",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${base}/v1/traces`,
    TELEMETRY_AUTH: "id_token",
    TELEMETRY_RECORD_CONTENT: "true",
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}
