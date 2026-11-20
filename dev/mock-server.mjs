// 開発用の模擬サーバー (1 つのポートで全部): Auth0 (OIDC)、AWS STS、Bedrock (ConverseStream)、
// AgentCore Code Interpreter、AppSync (チャット履歴)、Langfuse の OTLP 受け口。
// 本物のサービスなしで、ログイン → ツール呼び出し → 回答 → トレース送信までの流れを試すためのもの。
//
// 単体で起動: node dev/mock-server.mjs   (既定 http://127.0.0.1:9100、MOCK_PORT で変更)
// 通常は `npm run dev:mock` から起動される。
//
// 安全のため、Code Interpreter の模擬はコードを実行しない (受け取ったコードの要約を返すだけ)。

import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";

const codec = new EventStreamCodec(toUtf8, fromUtf8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
const frame = (type, payload) =>
  codec.encode({
    headers: {
      ":event-type": { type: "string", value: type },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "event" },
    },
    body: fromUtf8(JSON.stringify(payload)),
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
  /** 模擬の利用料金 (Bedrock の模擬応答のトークン数 × 例の単価)。本物は Langfuse が計算する */
  let mockCostUsd = 0;
  const keyOf = (req) => (req.headers.authorization ?? "").match(/Credential=(\w+)/)?.[1];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const raw = await readBody(req);
    const text = raw.toString();
    const json = (obj) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
    };

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

    // ---- AWS STS (AssumeRoleWithWebIdentity) ----
    if (url.pathname === "/" && text.includes("Action=AssumeRoleWithWebIdentity")) {
      const p = new URLSearchParams(text);
      log("STS: AssumeRoleWithWebIdentity", p.get("RoleArn"), "session:", p.get("RoleSessionName"));
      const exp = new Date(Date.now() + 3600_000).toISOString();
      res.setHeader("content-type", "text/xml");
      return res.end(
        `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult>` +
          `<Credentials><AccessKeyId>ASIAMOCKTEMP</AccessKeyId><SecretAccessKey>mock-secret</SecretAccessKey><SessionToken>mock-session</SessionToken><Expiration>${exp}</Expiration></Credentials>` +
          `<AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/mock/x</Arn><AssumedRoleId>AROAMOCK:x</AssumedRoleId></AssumedRoleUser>` +
          `</AssumeRoleWithWebIdentityResult><ResponseMetadata><RequestId>mock</RequestId></ResponseMetadata></AssumeRoleWithWebIdentityResponse>`,
      );
    }

    // ---- AgentCore Code Interpreter ----
    if (url.pathname.endsWith("/sessions/start")) {
      log("AgentCore: セッション開始 (署名キー:", keyOf(req), ")");
      return json({ codeInterpreterIdentifier: "aws.codeinterpreter.v1", sessionId: "mock-session-001", createdAt: new Date().toISOString() });
    }
    if (url.pathname.endsWith("/sessions/stop")) {
      log("AgentCore: セッション終了");
      return json({ codeInterpreterIdentifier: "aws.codeinterpreter.v1", sessionId: "mock-session-001", lastUpdatedAt: new Date().toISOString() });
    }
    if (url.pathname.endsWith("/tools/invoke")) {
      const b = JSON.parse(text);
      const source = b.arguments?.code ?? b.arguments?.command ?? "";
      log("AgentCore:", b.name, `(${source.split("\n").length} 行)`);
      const stdout = `[模擬] ${b.name} を受け取りました (${source.split("\n").length} 行)。模擬サーバーなので実行はしていません。\n`;
      res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream", "x-amzn-code-interpreter-session-id": "mock-session-001" });
      res.write(frame("result", { content: [{ type: "text", text: stdout }], structuredContent: { stdout, stderr: "", exitCode: 0, executionTime: 0.01 }, isError: false }));
      return res.end();
    }

    // ---- Bedrock ConverseStream ----
    if (url.pathname.includes("/converse-stream")) {
      const b = JSON.parse(text);
      const model = decodeURIComponent(url.pathname.split("/model/")[1]?.split("/")[0] ?? "");
      const tools = (b.toolConfig?.tools ?? []).map((t) => t.toolSpec?.name).filter(Boolean);
      const results = b.messages.flatMap((m) => m.content ?? []).filter((c) => c.toolResult);
      const lastUser = [...b.messages].reverse().find((m) => m.role === "user" && m.content?.some((c) => c.text));
      const question = lastUser?.content.find((c) => c.text)?.text ?? "";
      log("Bedrock:", model, "(署名キー:", keyOf(req), ") ツール", tools.length, "個、結果", results.length, "件");

      res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
      const send = (type, payload) => res.write(frame(type, payload));
      const callTool = async (name, input) => {
        send("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: `mock_tu_${results.length}`, name } } });
        const args = JSON.stringify(input);
        for (let i = 0; i < args.length; i += 24) {
          await sleep(40);
          send("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: args.slice(i, i + 24) } } });
        }
        send("contentBlockStop", { contentBlockIndex: 0 });
        send("messageStop", { stopReason: "tool_use" });
      };
      const resultText = (r) => {
        const t = (r.toolResult.content ?? []).map((c) => c.text ?? JSON.stringify(c.json)).join(" ");
        try {
          return (JSON.parse(t).output ?? t).trim();
        } catch {
          return t.trim();
        }
      };

      send("messageStart", { role: "assistant" });
      // 決まった筋書き: (1) MCP の時刻ツール → (2) Code Interpreter → (3) 回答
      const timeTool = tools.find((t) => t.endsWith("get_current_time"));
      const steps = [
        timeTool && (() => callTool(timeTool, { timezone: "Asia/Tokyo" })),
        tools.includes("code_interpreter_execute_code") &&
          (() => callTool("code_interpreter_execute_code", { language: "python", code: "from datetime import date\nprint((date(date.today().year, 12, 31) - date.today()).days)" })),
      ].filter(Boolean);
      if (results.length < steps.length) {
        await steps[results.length]();
      } else {
        const lines = results.map((r, i) => `${i + 1}. ${resultText(r)}`).join("\n");
        const msg =
          `（Bedrock の模擬応答です）\n\n「${question.slice(0, 80)}」を受け取りました。` +
          (lines ? `\n\nツールの結果:\n${lines}` : "\n\n使えるツールはありませんでした。");
        for (let i = 0; i < msg.length; i += 3) {
          await sleep(15);
          send("contentBlockDelta", { contentBlockIndex: 0, delta: { text: msg.slice(i, i + 3) } });
        }
        send("contentBlockStop", { contentBlockIndex: 0 });
        send("messageStop", { stopReason: "end_turn" });
      }
      send("metadata", { usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 }, metrics: { latencyMs: 1 } });
      mockCostUsd += 120 * 3e-6 + 40 * 15e-6;
      return res.end();
    }

    // ---- AppSync (チャット履歴の GraphQL API。OpenID Connect 認証) ----
    if (url.pathname === "/graphql") {
      // 本物の AppSync と同じく、ID トークンの sub で利用者を分ける (模擬なので署名は検証しない)
      let sub;
      try {
        sub = JSON.parse(Buffer.from((req.headers.authorization ?? "").split(".")[1], "base64url").toString()).sub;
      } catch {}
      if (!sub) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ errors: [{ errorType: "UnauthorizedException", message: "Valid authorization header not provided." }] }));
      }
      const { query, variables = {} } = JSON.parse(text);
      const mine = threads.get(sub) ?? new Map();
      threads.set(sub, mine);
      let data;
      if (query.includes("saveThread")) {
        const prev = mine.get(variables.id);
        const now = new Date().toISOString();
        mine.set(variables.id, { id: variables.id, title: variables.title, messagesGz: variables.messagesGz, updatedAt: now, createdAt: prev?.createdAt ?? now });
        data = { saveThread: { id: variables.id } };
        log("AppSync: saveThread", variables.id.slice(0, 8), `「${variables.title}」`, `${variables.messagesGz.length} 文字`);
      } else if (query.includes("deleteThread")) {
        data = { deleteThread: mine.delete(variables.id) || true };
        log("AppSync: deleteThread", variables.id.slice(0, 8));
      } else if (query.includes("usage")) {
        const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
        data = { usage: { todayUsd: mockCostUsd, monthUsd: mockCostUsd + 1.234, monthStart } };
        log("AppSync: usage", `今日 $${mockCostUsd.toFixed(4)}`);
      } else if (query.includes("threads")) {
        data = { threads: [...mine.values()].map(({ id, title, updatedAt }) => ({ id, title, updatedAt })) };
        log("AppSync: threads", data.threads.length, "件");
      } else if (query.includes("thread(")) {
        const t = mine.get(variables.id);
        data = { thread: t ? { messagesGz: t.messagesGz } : null };
        log("AppSync: thread", variables.id.slice(0, 8), t ? "" : "(なし)");
      } else {
        data = null;
      }
      return json({ data });
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

    // ---- Langfuse (OTLP/HTTP の受け口) ----
    if (url.pathname === "/api/public/otel/v1/traces") {
      const expected = "Basic " + Buffer.from(`${MOCK_LANGFUSE.publicKey}:${MOCK_LANGFUSE.secretKey}`).toString("base64");
      const ok = req.headers.authorization === expected;
      log("Langfuse: トレースを受信", `${raw.length} バイト`, ok ? "" : "(認証エラー)");
      res.writeHead(ok ? 200 : 401, { "content-type": "application/x-protobuf" });
      return res.end();
    }

    log("未対応のリクエスト:", req.method, url.pathname);
    res.writeHead(404).end();
  });

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
    log("起動しました:", base);
    resolve({ server, base });
  }));
}

// 単体で起動されたとき
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startMockServer();
}
