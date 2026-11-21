// 開発用の起動スクリプト。
// ルート (リポジトリの一番上) で実行する。
//   pnpm dev:mock  … 模擬サーバーを立てて、OAuth / STS / Bedrock / AgentCore / API Gateway / Collector を全部そこへ向ける
//   pnpm dev:aws   … ログインを省略し、AWS SDK 標準の認証 (AWS_PROFILE / SSO など) で本物の Bedrock を呼ぶ
//   pnpm dev:cloud … `pnpm dev-env up` で作った自分専用の AWS の開発環境 (Cognito でログイン) に向ける
// どちらも `tauri dev` (開発ビルド) で動く。リリースビルドでは、ログインの省略も http の模擬サーバーも使えない。

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exampleMcpConfig, mockEnv } from "./mock-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const isWindows = process.platform === "win32";

function tauriDev(env, unset = []) {
  const merged = { ...process.env, ...env };
  for (const key of unset) delete merged[key];
  const child = spawn("pnpm", ["exec", "tauri", "dev"], { cwd: root, stdio: "inherit", env: merged, shell: isWindows });
  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return child;
}

if (mode === "mock") {
  const { startMockServer } = await import("./mock-server.mjs");
  const { server, base } = await startMockServer();
  const child = tauriDev(mockEnv(base));
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
  // ルートの .env.cloud (自分の設定と、pnpm dev-env up が書いた接続先)。シェルで設定済みの値が優先
  const { CLOUD_ENV_FILE, readCloudEnv } = await import("./env-file.mjs");
  const file = readCloudEnv();
  const cloud = Object.fromEntries(
    ["OAUTH_ISSUER", "OAUTH_CLIENT_ID", "OAUTH_REDIRECT_PORT", "AWS_REGION", "AWS_ROLE_ARN", "CHAT_API_URL", "BEDROCK_MODEL_ID"]
      .map((k) => [k, process.env[k] ?? file[k]])
      .filter(([, v]) => v),
  );
  if (!cloud.CHAT_API_URL || !cloud.AWS_ROLE_ARN) {
    console.error(`[dev] ${CLOUD_ENV_FILE} に自分の開発環境の接続先がありません。先にルートで pnpm dev-env up を実行してください`);
    process.exit(1);
  }
  console.error(`[dev] ${file.DEV_ENV_USER ?? ""} の開発環境 (${cloud.CHAT_API_URL}) に向けて起動します`);
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
  console.error("使い方: pnpm dev:mock | dev:aws | dev:cloud (ルートで実行)");
  process.exit(1);
}
