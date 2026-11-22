// LLM プロキシ: API Gateway (REST API、レスポンスストリーミング) → この Lambda (InvokeWithResponseStream) → Bedrock / AgentCore
//
//   POST /v1/chat/completions        OpenAI 互換の Chat Completions (stream: true なら SSE)。Bedrock の ConverseStream に中継する
//   POST /v1/code-interpreter/invoke AgentCore Code Interpreter でコード / コマンドを実行する (セッションは利用者ごと)
//   POST /v1/code-interpreter/stop   セッションを止める
//
// アプリ (各 PC の Rig) は AWS の認証情報を持たず、ID トークンだけでここを呼ぶ。ID トークンはオーソライザー (authorizer.ts) が
// 検証済みで、この Lambda は requestContext.authorizer.sub だけで利用者を分ける。サーバー側で守ること:
//   - 呼べるモデル: MODEL_PRICES に載っているモデルだけ (料金が分からないモデルは上限を守れないため)
//   - 出力トークンの上限: MAX_OUTPUT_TOKENS
//   - 利用上限: 呼ぶ前に台帳 (ledger.ts) で確かめ、達していれば 429。呼んだ後に Bedrock が返したトークン数から料金を足す
//   - ログ: 呼び出しごとに利用者・モデル・トークン数・料金・所要時間を 1 行の JSON で CloudWatch Logs に出す (本文は出さない)
// アプリが改造されていても、これらは迂回できない。
//
// API Gateway のストリーミングでは、関数は awslambda.HttpResponseStream.from で「メタデータ (状態コードとヘッダー) +
// 区切り」を先に書いてから本文を書く。
import { createHash } from "node:crypto";
import type { Writable } from "node:stream";
import {
  BedrockAgentCoreClient,
  GetCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  type ProgrammingLanguage,
  StartCodeInterpreterSessionCommand,
  StopCodeInterpreterSessionCommand,
  type ToolArguments,
} from "@aws-sdk/client-bedrock-agentcore";
import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Context } from "aws-lambda";
import { type Event, subOf } from "./http.ts";
import { addUsage, usageOf } from "./ledger.ts";
import { BadRequest, type ChatRequest, StreamTranslator, completionOf, toConverse } from "./openai.ts";
import { type TokenUsage, costOf, parsePriceTable } from "./pricing.ts";

const bedrock = new BedrockRuntimeClient({});
const agentcore = new BedrockAgentCoreClient({});
const prices = parsePriceTable(process.env.MODEL_PRICES);
const maxOutputTokens = Number(process.env.MAX_OUTPUT_TOKENS ?? 16384);
const codeInterpreterId = process.env.CODE_INTERPRETER_ID ?? "aws.codeinterpreter.v1";
/** 1 リクエストの本文の上限 (会話全体を毎回送るので、余裕を持たせる) */
const MAX_BODY_BYTES = 6 * 1024 * 1024;

type Meta = { statusCode: number; headers: Record<string, string> };

/** 状態コードとヘッダーを書いた応答のストリーム */
function open(stream: Writable, meta: Meta): Writable {
  return awslambda.HttpResponseStream.from(stream, meta as unknown as Record<string, unknown>);
}

function sendJson(stream: Writable, statusCode: number, body: unknown): void {
  const out = open(stream, { statusCode, headers: { "content-type": "application/json" } });
  out.write(JSON.stringify(body));
  out.end();
}

/** OpenAI 互換のエラー (Rig はこの message を表示する) */
function sendError(stream: Writable, statusCode: number, message: string, type: string): void {
  sendJson(stream, statusCode, { error: { message, type, code: type } });
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

function bodyOf(event: Event): unknown {
  if (!event.body) throw new BadRequest("本文がありません");
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new BadRequest("本文が大きすぎます");
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequest("本文が JSON ではありません");
  }
}

function blockedMessage(limitUsd: number | null): string {
  const limit = limitUsd === null ? "" : ` ($${limitUsd.toFixed(2)})`;
  return `今月の利用上限${limit}に達したため、新しいメッセージを送れません。上限は毎月 1 日に自動でリセットされます。急ぎの場合は管理者に上限の変更かリセットを依頼してください。`;
}

/** 料金を台帳に足してログに出す。失敗しても応答はもう返しているので、ログだけ残す */
async function settle(sub: string, model: string, usage: TokenUsage | undefined, fields: Record<string, unknown>): Promise<void> {
  const u = usage ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  const cost = costOf(prices[model], u);
  try {
    await addUsage(sub, model, u, cost.total);
  } catch (e) {
    console.error("利用料金を台帳に記録できません", e);
    fields.ledgerError = String(e);
  }
  log({ event: "chat_completion", sub, model, ...u, costUsd: cost.total, ...fields });
}

async function chatCompletions(event: Event, stream: Writable, sub: string): Promise<void> {
  const started = Date.now();
  const req = bodyOf(event) as ChatRequest;
  const model = typeof req.model === "string" ? req.model : "";
  if (!prices[model]) {
    log({ event: "chat_completion_rejected", sub, model, reason: "model_not_allowed" });
    return sendError(stream, 400, `モデル ${model || "(未指定)"} は使えません。使えるモデル: ${Object.keys(prices).join(", ")}`, "model_not_allowed");
  }
  const input = toConverse(req, maxOutputTokens);

  // 利用上限 (管理者が決める)。確かめられないとき (DynamoDB の障害など) は止めずに通す
  try {
    const usage = await usageOf(sub);
    if (usage.blocked) {
      log({ event: "chat_completion_rejected", sub, model, reason: "usage_limit_exceeded", periodUsd: usage.periodUsd, limitUsd: usage.limitUsd });
      return sendError(stream, 429, blockedMessage(usage.limitUsd), "usage_limit_exceeded");
    }
  } catch (e) {
    console.warn("利用上限を確かめられないため、そのまま通します", e);
  }

  if (!req.stream) {
    const out = await bedrock.send(new ConverseCommand({ modelId: model, ...input }));
    const { body, usage } = completionOf(model, out);
    sendJson(stream, 200, body);
    return settle(sub, model, usage, { stream: false, stopReason: out.stopReason, latencyMs: Date.now() - started });
  }

  const out = await bedrock.send(new ConverseStreamCommand({ modelId: model, ...input }));
  const sse = open(stream, { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  const t = new StreamTranslator(model);
  let firstTokenMs: number | undefined;
  let streamError: string | undefined;
  try {
    for await (const ev of out.stream ?? []) {
      for (const chunk of t.next(ev)) {
        firstTokenMs ??= Date.now() - started;
        sse.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }
  } catch (e) {
    // 途中で失敗したら、OpenAI と同じく error を 1 件送って終わる (ここまでのトークン分も料金に入れる)
    streamError = e instanceof Error ? e.message : String(e);
    sse.write(`data: ${JSON.stringify({ error: { message: streamError, type: "upstream_error" } })}\n\n`);
  }
  sse.write("data: [DONE]\n\n");
  sse.end();
  await settle(sub, model, t.usage, {
    stream: true,
    stopReason: t.stopReason,
    latencyMs: Date.now() - started,
    firstTokenMs,
    ...(streamError ? { error: streamError } : {}),
  });
}

// ---- Code Interpreter ----

/** セッション名の接頭辞 (利用者ごと)。sub そのものは名前に入れず、ハッシュにする */
export function ownerPrefix(sub: string): string {
  return `u${createHash("sha256").update(sub).digest("hex").slice(0, 24)}`;
}

/** セッション名: 接頭辞 + 会話 ID の英数字 (Code Interpreter のセッション名に使える文字だけ) */
export function sessionName(sub: string, threadId: string): string {
  const thread = threadId.replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  return `${ownerPrefix(sub)}t${thread}`;
}

/** そのセッションがこの利用者のもので、まだ使えるか (ほかの人のセッション ID を渡されても使わせない) */
async function ownsSession(sub: string, sessionId: string): Promise<boolean> {
  try {
    const s = await agentcore.send(new GetCodeInterpreterSessionCommand({ codeInterpreterIdentifier: codeInterpreterId, sessionId }));
    return (s.name ?? "").startsWith(ownerPrefix(sub)) && s.status === "READY";
  } catch {
    return false;
  }
}

async function startSession(sub: string, threadId: string): Promise<string> {
  const s = await agentcore.send(
    new StartCodeInterpreterSessionCommand({
      codeInterpreterIdentifier: codeInterpreterId,
      name: sessionName(sub, threadId),
      sessionTimeoutSeconds: 3600,
    }),
  );
  if (!s.sessionId) throw new Error("Code Interpreter がセッション ID を返しませんでした");
  return s.sessionId;
}

type InvokeBody = { threadId?: unknown; sessionId?: unknown; tool?: unknown; arguments?: Record<string, unknown> };

export function toolArguments(body: InvokeBody): { name: "executeCode" | "executeCommand"; args: ToolArguments } {
  const a = body.arguments ?? {};
  if (body.tool === "executeCode") {
    if (typeof a.code !== "string" || a.code === "") throw new BadRequest("code がありません");
    const language = (["python", "javascript", "typescript"].includes(String(a.language)) ? a.language : "python") as ProgrammingLanguage;
    return { name: "executeCode", args: { code: a.code, language } };
  }
  if (body.tool === "executeCommand") {
    if (typeof a.command !== "string" || a.command === "") throw new BadRequest("command がありません");
    return { name: "executeCommand", args: { command: a.command } };
  }
  throw new BadRequest("tool は executeCode か executeCommand にしてください");
}

async function invoke(sessionId: string, name: "executeCode" | "executeCommand", args: ToolArguments) {
  const out = await agentcore.send(
    new InvokeCodeInterpreterCommand({ codeInterpreterIdentifier: codeInterpreterId, sessionId, name, arguments: args }),
  );
  const texts: string[] = [];
  let structured: unknown = null;
  let isError = false;
  for await (const ev of out.stream ?? []) {
    if (ev.result) {
      isError ||= ev.result.isError ?? false;
      texts.push(...(ev.result.content ?? []).flatMap((c) => (c.text ? [c.text] : [])));
      const s = ev.result.structuredContent;
      if (s) structured = { stdout: s.stdout, stderr: s.stderr, exitCode: s.exitCode, executionTime: s.executionTime };
    }
    const err = ev.accessDeniedException ?? ev.validationException ?? ev.internalServerException ?? ev.throttlingException ?? ev.resourceNotFoundException ?? ev.conflictException ?? ev.serviceQuotaExceededException;
    if (err) throw new Error(err.message ?? "Code Interpreter でエラーが起きました");
  }
  return { isError, output: texts.join("\n"), result: structured };
}

async function codeInterpreter(event: Event, stream: Writable, sub: string, action: string): Promise<void> {
  const started = Date.now();
  const body = bodyOf(event) as InvokeBody;
  const given = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : undefined;

  if (action === "stop") {
    if (given && (await ownsSession(sub, given))) {
      await agentcore.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: codeInterpreterId, sessionId: given }));
    }
    log({ event: "code_interpreter_stop", sub });
    return sendJson(stream, 200, { stopped: true });
  }

  const threadId = typeof body.threadId === "string" ? body.threadId : "";
  const { name, args } = toolArguments(body);
  // 渡されたセッションが本人のものでまだ使えればそれを使い、なければ新しく作る。失敗したら新しいセッションで 1 回だけやり直す
  let sessionId = given && (await ownsSession(sub, given)) ? given : await startSession(sub, threadId);
  let result;
  try {
    result = await invoke(sessionId, name, args);
  } catch (e) {
    console.warn("Code Interpreter をやり直します", e);
    sessionId = await startSession(sub, threadId);
    result = await invoke(sessionId, name, args);
  }
  log({ event: "code_interpreter_invoke", sub, tool: name, isError: result.isError, newSession: sessionId !== given, latencyMs: Date.now() - started });
  sendJson(stream, 200, { sessionId, ...result });
}

// ---- 入口 ----

export async function route(event: Event, stream: Writable): Promise<void> {
  const sub = subOf(event);
  if (!sub) return sendError(stream, 401, "Unauthorized", "unauthorized");
  try {
    switch (`${event.httpMethod} ${event.resource}`) {
      case "POST /v1/chat/completions":
        return await chatCompletions(event, stream, sub);
      case "POST /v1/code-interpreter/invoke":
        return await codeInterpreter(event, stream, sub, "invoke");
      case "POST /v1/code-interpreter/stop":
        return await codeInterpreter(event, stream, sub, "stop");
      default:
        return sendError(stream, 404, "Not Found", "not_found");
    }
  } catch (e) {
    if (e instanceof BadRequest) return sendError(stream, 400, e.message, "invalid_request_error");
    // Bedrock の失敗 (スロットリング・入力の不正など) は状態コードを引き継ぐ
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const message = e instanceof Error ? e.message : String(e);
    console.error("プロキシの処理に失敗しました", e);
    return sendError(stream, status && status >= 400 && status < 600 ? status : 502, message, "upstream_error");
  }
}

// Lambda の Node.js ランタイムでは awslambda がグローバルにある (ローカルのテストでは無い)
const streamify =
  typeof awslambda !== "undefined"
    ? awslambda.streamifyResponse
    : (h: (e: Event, s: Writable, c: Context) => Promise<void>) => h;

export const handler = streamify(async (event: Event, stream: Writable) => {
  await route(event, stream);
});
