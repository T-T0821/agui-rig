// 開発用の起動スクリプト。
//   npm run dev:mock  … 模擬サーバーを立てて、OAuth / STS / Bedrock / AgentCore / API Gateway / Collector を全部そこへ向ける
//   npm run dev:aws   … ログインを省略し、AWS SDK 標準の認証 (AWS_PROFILE / SSO など) で本物の Bedrock を呼ぶ
//   npm run dev:cloud … `npm run dev-env -- up` で作った自分専用の AWS の開発環境 (Cognito でログイン) に向ける
// どちらも `tauri dev` (開発ビルド) で動く。リリースビルドでは、ログインの省略も http の模擬サーバーも使えない。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function tauriDev(env, unset = []) {
  const merged = { ...process.env, ...env };
  for (const key of unset) delete merged[key];
  const child = spawn("npx", ["tauri", "dev"], { cwd: root, stdio: "inherit", env: merged, shell: isWindows });
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
} else if (mode === "cloud") {
  // dev/cloud-env.mjs (npm run dev-env -- up) が書いた、自分の開発環境の接続先
  const file = join(root, ".dev-cloud.json");
  if (!existsSync(file)) {
    console.error("[dev] 自分の開発環境がありません。先に npm run dev-env -- up で作ってください");
    process.exit(1);
  }
  const { DEV_ENV_USER: user, ...cloud } = JSON.parse(readFileSync(file, "utf8"));
  console.error(`[dev] ${user} の開発環境 (${cloud.CHAT_API_URL}) に向けて起動します`);
  const child = tauriDev(
    {
      ...cloud,
      // 本物のログイン (Cognito) → STS → Bedrock / AgentCore
      DEV_SKIP_LOGIN: "",
      LLM_MODEL: "",
      MCP_CONFIG: process.env.MCP_CONFIG || exampleMcpConfig(),
    },
    // 模擬サーバー向けのエンドポイントが環境に残っていれば外す (AWS SDK が直接読む)
    ["AWS_ENDPOINT_URL_STS", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_ENDPOINT_URL_BEDROCK_AGENTCORE", "AWS_PROFILE"],
  );
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  console.error("使い方: node dev/run.mjs mock | aws | cloud");
  process.exit(1);
}
