// E2E テスト: 開発ビルドのアプリ (Tauri) を tauri-driver (WebDriver) で操作する。
// OAuth / STS / Bedrock / AgentCore / API Gateway / Collector はすべて dev/mock-server.mjs の模擬。
//
// 事前に (ルートで): pnpm install && pnpm tauri build --debug --no-bundle と cargo install tauri-driver
// Linux では WebKitWebDriver (webkit2gtk-driver) も要る。画面の無い環境では xvfb-run で動かす。
// 結果のスクリーンショット (と、ffmpeg があれば録画) は e2e/artifacts/ に出る。

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exampleMcpConfig, mockEnv } from "../dev/mock-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
/**
 * mock (既定): 全部を模擬サーバーに向ける。
 * aws: `pnpm dev:aws` と同じく、ログインを省略して AWS SDK 標準の認証 (AWS_PROFILE など) で本物の Bedrock を呼ぶ
 */
const mode = process.env.E2E_MODE === "aws" ? "aws" : "mock";
const isWindows = process.platform === "win32";
const port = Number(process.env.MOCK_PORT ?? 9123);
export const mockBase = `http://127.0.0.1:${port}`;
export const artifacts = resolve(here, "artifacts");
const application =
  process.env.E2E_APP ?? resolve(here, "../src-tauri/target/debug", isWindows ? "rig-agui-chat.exe" : "rig-agui-chat");

let mock;
let recorder;
let tauriDriver;

/**
 * アプリは「ログイン」でブラウザを開こうとする (Linux では xdg-open)。テストでは本物のブラウザの代わりに、
 * 認可 URL を取得してリダイレクト (模擬サーバー → アプリのコールバック) をたどるだけの xdg-open を PATH の先頭に置く。
 */
function fakeBrowserDir() {
  const dir = join(tmpdir(), "rig-agui-e2e-bin");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "xdg-open");
  writeFileSync(
    script,
    `#!/usr/bin/env node
fetch(process.argv[2]).then((r) => console.error("[fake-browser]", r.status, r.url), (e) => console.error("[fake-browser]", e));
`,
  );
  chmodSync(script, 0o755);
  return dir;
}

/** tauri-driver の裏で動く WebDriver (Linux では WebKitWebDriver、ポート 4445) が受け付けるまで待つ。 */
async function waitForPort(port, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ok = await new Promise((r) => {
      const s = connect(port, "127.0.0.1", () => (s.destroy(), r(true))).on("error", () => r(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`ポート ${port} の WebDriver が起動しません`);
}

export const config = {
  runner: "local",
  specs: [mode === "aws" ? "./specs/aws/*.e2e.mjs" : "./specs/*.e2e.mjs"],
  maxInstances: 1,
  hostname: "127.0.0.1",
  port: 4444,
  capabilities: [{ "tauri:options": { application } }],
  logLevel: "warn",
  waitforTimeout: 30_000,
  connectionRetryCount: 0,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 180_000 },

  onPrepare: async () => {
    rmSync(artifacts, { recursive: true, force: true });
    mkdirSync(artifacts, { recursive: true });
    if (mode === "mock") {
      const { startMockServer } = await import("../dev/mock-server.mjs");
      mock = (await startMockServer({ port, log: (...a) => console.error("[mock]", ...a) })).server;
    }

    // 画面の録画 (Xvfb などの X ディスプレイがあり、ffmpeg が入っているときだけ)。既定はアプリの窓の大きさ
    if (process.env.DISPLAY && process.env.E2E_VIDEO !== "0" && spawnSync("ffmpeg", ["-version"]).status === 0) {
      const size = process.env.E2E_VIDEO_SIZE ?? "900x720";
      recorder = spawn(
        "ffmpeg",
        ["-y", "-loglevel", "error", "-f", "x11grab", "-video_size", size, "-framerate", "10", "-i", process.env.DISPLAY,
          "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", join(artifacts, "e2e.mp4")],
        { stdio: ["pipe", "inherit", "inherit"] },
      );
    }
  },

  beforeSession: async () => {
    const env =
      mode === "aws"
        ? { ...process.env, DEV_SKIP_LOGIN: "1", MCP_CONFIG: process.env.MCP_CONFIG || exampleMcpConfig() }
        : { ...process.env, ...mockEnv(mockBase) };
    if (!isWindows) env.PATH = `${fakeBrowserDir()}${delimiter}${env.PATH}`;
    tauriDriver = spawn(process.env.TAURI_DRIVER ?? join(homedir(), ".cargo", "bin", "tauri-driver"), [], {
      stdio: [null, process.stdout, process.stderr],
      env,
    });
    // セッションを作れなかったときは afterSession が呼ばれないので、ワーカーの終了時にも止める
    process.on("exit", () => tauriDriver?.kill());
    await waitForPort(4444);
    await waitForPort(4445);
  },

  afterSession: () => {
    tauriDriver?.kill();
  },

  onComplete: async () => {
    if (recorder) {
      recorder.stdin.write("q");
      await new Promise((r) => recorder.on("exit", r));
    }
    mock?.close();
  },
};
