// 開発用の起動スクリプト。
//   npm run dev:mock  … 模擬サーバーを立てて、OAuth / STS / Bedrock / AgentCore / AppSync / Collector を全部そこへ向ける
//   npm run dev:aws   … ログインを省略し、AWS SDK 標準の認証 (AWS_PROFILE / SSO など) で本物の Bedrock を呼ぶ
// どちらも `tauri dev` (開発ビルド) で動く。リリースビルドでは、ログインの省略も http の模擬サーバーも使えない。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const isWindows = process.platform === "win32";

/** 動作確認用の stdio MCP サーバー (時刻ツール) の設定を一時ファイルに書く。 */
function exampleMcpConfig() {
  const dir = join(root, "examples", "time-mcp");
  if (!existsSync(join(dir, "node_modules"))) {
    console.error("[dev] 例の MCP サーバーの依存をインストールします…");
    spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit", shell: isWindows });
  }
  const path = join(mkdtempSync(join(tmpdir(), "rig-agui-dev-")), "mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { time: { command: "node", args: [join(dir, "server.mjs")] } } }, null, 2));
  return path;
}

function tauriDev(env) {
  const child = spawn("npx", ["tauri", "dev"], { cwd: root, stdio: "inherit", env: { ...process.env, ...env }, shell: isWindows });
  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return child;
}

if (mode === "mock") {
  const { startMockServer } = await import("./mock-server.mjs");
  const { server, base } = await startMockServer();
  const noProxy = ["127.0.0.1", "localhost", process.env.NO_PROXY].filter(Boolean).join(",");
  const child = tauriDev({
    // 環境変数は .env や config.json より優先されるので、ここで全部を模擬サーバーに向ける
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
    CHAT_API_URL: `${base}/graphql`,
    // トレースは本番と同じく Collector へ、ID トークンで認証して送る (Langfuse のキーはアプリに渡さない)
    LANGFUSE_PUBLIC_KEY: "",
    LANGFUSE_SECRET_KEY: "",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${base}/v1/traces`,
    TELEMETRY_AUTH: "id_token",
    TELEMETRY_RECORD_CONTENT: "true",
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  });
  child.on("exit", (code) => {
    server.close();
    process.exit(code ?? 0);
  });
} else if (mode === "aws") {
  const child = tauriDev({
    // OAuth を使わず、AWS SDK 標準の認証 (AWS_PROFILE、aws sso login 済みのプロファイルなど) を使う
    DEV_SKIP_LOGIN: "1",
    MCP_CONFIG: process.env.MCP_CONFIG || exampleMcpConfig(),
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  console.error("使い方: node dev/run.mjs mock | aws");
  process.exit(1);
}
