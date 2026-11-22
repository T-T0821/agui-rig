// 開発用の模擬サーバー (1 つのポートで全部): Auth0 (OIDC)、バックエンド (API Gateway: チャット履歴・利用料金・
// LLM プロキシ (OpenAI 互換の Chat Completions)・Code Interpreter の中継)、Collector / Langfuse の OTLP 受け口。
// 本物のサービスなしで、ログイン → ツール呼び出し → 回答 → トレース送信までの流れを試すためのもの。
//
// 単体で起動: node dev/mock-server.mjs   (既定 http://127.0.0.1:9100、MOCK_PORT で変更)
// 通常はルートの `pnpm dev:mock` から起動される。
//
// 安全のため、Code Interpreter の模擬はコードを実行しない (受け取ったコードの要約を返すだけ)。

import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
/** 模擬の利用者。ID トークンに入る。 */
export const MOCK_USER = { sub: "mock-user-001", name: "模擬 太郎", email: "mock.user@example.com" };
/** Langfuse の模擬キー (本物ではない)。 */
export const MOCK_LANGFUSE = { publicKey: "pk-lf-mock", secretKey: "sk-lf-mock" };

export function startMockServer({ port = Number(process.env.MOCK_PORT ?? 9100), log = (...a) => console.error("[mock]", ...a) } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const idToken = () =>
    `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
      iss: base,
      aud: "chat-app",
      ...MOCK_USER,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.mock`;
  /** チャット履歴 (sub → 会話 ID → 会話)。メモリだけなので、模擬サーバーを止めると消える。 */
  const threads = new Map();
  /** 模擬の利用料金 (LLM プロキシの模擬応答のトークン数 × 例の単価)。本物はプロキシが DynamoDB の台帳に記録する */
  let mockCostUsd = 0;
  /** E2E テストなどから変える利用上限 (PUT /__mock/config)。null なら MOCK_MONTHLY_LIMIT_USD を使う */
  let limitOverride = null;
  /** 今月の模擬の利用料金と、上限の状態 (/usage と、プロキシの上限チェックで共通) */
  const usageNow = () => {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const monthUsd = mockCostUsd + 1.234;
    // 利用上限の模擬: MOCK_MONTHLY_LIMIT_USD (例 1.24 にすると数回のやり取りで上限に達する)。未設定なら上限なし
    const limit = Number(limitOverride ?? process.env.MOCK_MONTHLY_LIMIT_USD ?? 0);
    const limitUsd = limit > 0 ? limit : null;
    const blocked = limitUsd !== null && monthUsd >= limitUsd;
    const warn = limitUsd !== null && monthUsd >= limitUsd * 0.8;
    return { todayUsd: mockCostUsd, monthUsd, monthStart, limitUsd, periodStart: monthStart, periodUsd: monthUsd, warn, blocked };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const raw = await readBody(req);
    const text = raw.toString();
    const json = (obj) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
    };

    // ---- 模擬サーバー自身の設定 (E2E テスト用) ----
    if (url.pathname === "/__mock/config" && req.method === "PUT") {
      const b = JSON.parse(text || "{}");
      if ("monthlyLimitUsd" in b) limitOverride = b.monthlyLimitUsd;
      log("設定を変更:", JSON.stringify(b));
      return json({ monthlyLimitUsd: limitOverride });
    }

    // ---- Auth0 (OIDC) ----
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
    }
    if (url.pathname === "/authorize") {
      // ログイン画面は出さず、すぐにアプリへ戻す
      log("OAuth: 認可リクエスト (PKCE:", url.searchParams.get("code_challenge_method"), ")");
      const to = new URL(url.searchParams.get("redirect_uri"));
      to.searchParams.set("code", "mock-code");
      to.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { Location: to.toString(), "content-type": "text/html; charset=utf-8" });
      return res.end("模擬ログインが完了しました。アプリに戻ってください。");
    }
    if (url.pathname === "/token") {
      const p = new URLSearchParams(text);
      log("OAuth: トークン発行", p.get("grant_type"));
      return json({ access_token: "mock-at", id_token: idToken(), refresh_token: "mock-rt", token_type: "Bearer", expires_in: 3600 });
    }

    // ---- Langfuse (OTLP/HTTP の受け口) ----
    if (url.pathname === "/api/public/otel/v1/traces") {
      const expected = "Basic " + Buffer.from(`${MOCK_LANGFUSE.publicKey}:${MOCK_LANGFUSE.secretKey}`).toString("base64");
      const ok = req.headers.authorization === expected;
      log("Langfuse: トレースを受信", `${raw.length} バイト`, ok ? "" : "(認証エラー)");
      res.writeHead(ok ? 200 : 401, { "content-type": "application/x-protobuf" });
      return res.end();
    }

    // ---- バックエンド (API Gateway の REST API + Lambda オーソライザー → Lambda) ----
    // CHAT_API_URL = <base>/api。本物と同じく ID トークンの sub で利用者を分ける (模擬なので署名は検証しない)
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const send = (status, body) => {
        res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
        return res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      let sub;
      try {
        const [scheme, token] = (req.headers.authorization ?? "").split(" ");
        if (scheme === "Bearer") sub = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
      } catch {}
      if (!sub) return send(401, { message: "Unauthorized" });
      const mine = threads.get(sub) ?? new Map();
      threads.set(sub, mine);
      const path = url.pathname.slice("/api".length);
      const route = `${req.method} ${path.replace(/^\/threads\/[^/]+$/, "/threads/{id}")}`;
      const id = decodeURIComponent(path.split("/")[2] ?? "");
      switch (route) {
        case "GET /threads": {
          const list = [...mine.values()].map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
          log("API: GET /threads", list.length, "件");
          return send(200, list);
        }
        case "GET /threads/{id}": {
          const t = mine.get(id);
          log("API: GET /threads/{id}", id.slice(0, 8), t ? "" : "(なし)");
          return t ? send(200, t) : send(404, { message: "会話がありません" });
        }
        case "PUT /threads/{id}": {
          const { title, messagesGz } = JSON.parse(text);
          if (typeof title !== "string" || typeof messagesGz !== "string") return send(400, { message: "本文が不正です" });
          const prev = mine.get(id);
          const now = new Date().toISOString();
          mine.set(id, { id, title, messagesGz, updatedAt: now, createdAt: prev?.createdAt ?? now });
          log("API: PUT /threads/{id}", id.slice(0, 8), `「${title}」`, `${messagesGz.length} 文字`);
          return send(200, { id, title, updatedAt: now });
        }
        case "DELETE /threads/{id}":
          mine.delete(id);
          log("API: DELETE /threads/{id}", id.slice(0, 8));
          return send(204);
        case "GET /usage": {
          const u = usageNow();
          log("API: GET /usage", `今日 $${u.todayUsd.toFixed(4)}`, u.limitUsd ? `上限 $${u.limitUsd}${u.blocked ? " (到達)" : ""}` : "");
          return send(200, u);
        }
        case "POST /v1/chat/completions":
          return chatCompletions(JSON.parse(text || "{}"), res, send, sub);
        case "POST /v1/code-interpreter/invoke": {
          // 本物はプロキシが AgentCore を呼ぶ。模擬はコードを実行せず、受け取ったものの要約を返す
          const b = JSON.parse(text || "{}");
          const source = b.arguments?.code ?? b.arguments?.command ?? "";
          const sessionId = typeof b.sessionId === "string" && b.sessionId ? b.sessionId : `mock-session-${String(b.threadId ?? "").slice(0, 8)}`;
          log("API: Code Interpreter", b.tool, `(${source.split("\n").length} 行)`, b.sessionId ? "" : "(新しいセッション)");
          const stdout = `[模擬] ${b.tool} を受け取りました (${source.split("\n").length} 行)。模擬サーバーなので実行はしていません。\n`;
          return send(200, { sessionId, isError: false, output: stdout, result: { stdout, stderr: "", exitCode: 0, executionTime: 0.01 } });
        }
        case "POST /v1/code-interpreter/stop":
          log("API: Code Interpreter のセッション終了");
          return send(204);
        default:
          return send(404, { message: "Not Found" });
      }
    }

    // ---- OTel Collector (OTLP/HTTP の受け口、ID トークンで認証) ----
    // 本物の Collector は oidc 認証拡張で署名・issuer・audience・期限を確かめる。ここでは署名以外を確かめる
    if (url.pathname === "/v1/traces") {
      let claims;
      try {
        const [scheme, token] = (req.headers.authorization ?? "").split(" ");
        claims = scheme === "Bearer" ? JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) : null;
      } catch {
        claims = null;
      }
      const ok = claims?.iss === base && claims?.aud === "chat-app" && claims.exp > Date.now() / 1000;
      log("Collector: トレースを受信", `${raw.length} バイト`, ok ? `(利用者 ${claims.sub})` : "(認証エラー)");
      res.writeHead(ok ? 200 : 401, { "content-type": "application/x-protobuf" });
      return res.end();
    }

    log("未対応のリクエスト:", req.method, url.pathname);
    res.writeHead(404).end();
  });

  /**
   * LLM プロキシ (POST /api/v1/chat/completions) の模擬。OpenAI 互換の SSE を返す。
   * 決まった筋書き: (1) MCP の時刻ツール → (2) Code Interpreter → (3) 回答。
   * 本物と同じく、許可されたモデルだけ受け付け、上限に達していれば 429 を返す。
   */
  async function chatCompletions(b, res, send, sub) {
    const model = b.model ?? "";
    if (model !== "global.anthropic.claude-sonnet-5-5") {
      log("LLM プロキシ: 許可されていないモデル", model);
      return send(400, { error: { message: `モデル ${model || "(未指定)"} は使えません`, type: "model_not_allowed" } });
    }
    const usage = usageNow();
    if (usage.blocked) {
      log("LLM プロキシ: 利用上限に達しているので断りました");
      return send(429, { error: { message: `今月の利用上限 ($${usage.limitUsd.toFixed(2)}) に達したため、新しいメッセージを送れません。`, type: "usage_limit_exceeded" } });
    }
    const messages = b.messages ?? [];
    const tools = (b.tools ?? []).map((t) => t.function?.name).filter(Boolean);
    const results = messages.filter((m) => m.role === "tool");
    const textOf = (c) => (typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? "").join(""));
    const question = textOf([...messages].reverse().find((m) => m.role === "user")?.content);
    log("LLM プロキシ:", model, `(利用者 ${sub}) ツール`, tools.length, "個、結果", results.length, "件", b.stream ? "" : "(ストリームなし)");

    const id = `chatcmpl-mock-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta, finish_reason = null) =>
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const callTool = async (name, input) => {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `mock_tc_${results.length}`, type: "function", function: { name, arguments: "" } }] });
      const args = JSON.stringify(input);
      for (let i = 0; i < args.length; i += 24) {
        await sleep(40);
        chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 24) } }] });
      }
      chunk({}, "tool_calls");
    };
    const resultText = (m) => {
      const t = textOf(m.content);
      try {
        return (JSON.parse(t).output ?? t).trim();
      } catch {
        return t.trim();
      }
    };

    const timeTool = tools.find((t) => t.endsWith("get_current_time"));
    const steps = [
      timeTool && (() => callTool(timeTool, { timezone: "Asia/Tokyo" })),
      tools.includes("code_interpreter_execute_code") &&
        (() => callTool("code_interpreter_execute_code", { language: "python", code: "from datetime import date\nprint((date(date.today().year, 12, 31) - date.today()).days)" })),
    ].filter(Boolean);
    if (results.length < steps.length) {
      await steps[results.length]();
    } else {
      const lines = results.map((m, i) => `${i + 1}. ${resultText(m)}`).join("\n");
      const msg =
        `（LLM プロキシの模擬応答です）\n\n「${question.slice(0, 80)}」を受け取りました。` +
        (lines ? `\n\nツールの結果:\n${lines}` : "\n\n使えるツールはありませんでした。");
      chunk({ role: "assistant", content: "" });
      for (let i = 0; i < msg.length; i += 3) {
        await sleep(15);
        chunk({ content: msg.slice(i, i + 3) });
      }
      chunk({}, "stop");
    }
    // 本物と同じく、最後に usage だけの chunk (stream_options.include_usage)
    const usageChunk = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160, prompt_tokens_details: { cached_tokens: 0 } };
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: usageChunk })}\n\n`);
    res.write("data: [DONE]\n\n");
    mockCostUsd += 120 * 2e-6 + 40 * 10e-6;
    return res.end();
  }

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
    log("起動しました:", base);
    resolve({ server, base });
  }));
}

// 単体で起動されたとき
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startMockServer();
}
