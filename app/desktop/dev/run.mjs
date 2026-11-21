// 開発用の起動スクリプト。
//   npm run dev:mock  … 模擬サーバーを立てて、OAuth / STS / Bedrock / AgentCore / API Gateway / Collector を全部そこへ向ける
//   npm run dev:aws   … ログインを省略し、AWS SDK 標準の認証 (AWS_PROFILE / SSO など) で本物の Bedrock を呼ぶ
// どちらも `tauri dev` (開発ビルド) で動く。リリースビルドでは、ログインの省略も http の模擬サーバーも使えない。

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exampleMcpConfig, mockEnv } from "./mock-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const isWindows = process.platform === "win32";

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
} else {
  console.error("使い方: node dev/run.mjs mock | aws");
  process.exit(1);
}
