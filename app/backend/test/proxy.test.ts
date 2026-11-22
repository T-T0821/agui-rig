import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";
import { stageWildcard } from "../src/authorizer.ts";
import { bearerToken, userNameOfClaims, verifyIdToken } from "../src/jwt.ts";
import { BadRequest, StreamTranslator, completionOf, finishReason, openAiUsage, toConverse } from "../src/openai.ts";
import { costOf, parsePriceTable } from "../src/pricing.ts";
import { headerOf, otlpBody, parseTraceparent, sendGeneration } from "../src/trace.ts";

// ---- OpenAI → Converse ----

test("Rig が送る会話を Converse の形にする (役割が続けばまとめ、ツールの結果は user 側に)", () => {
  const input = toConverse(
    {
      model: "m",
      max_tokens: 100_000,
      messages: [
        { role: "system", content: "あなたは親切です" },
        { role: "user", content: "今何時？" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "time__now", arguments: '{"tz":"Asia/Tokyo"}' } }] },
        { role: "tool", tool_call_id: "c1", content: "12:00" },
        { role: "user", content: [{ type: "text", text: "ありがとう" }] },
      ],
      tools: [{ type: "function", function: { name: "time__now", description: "時刻", parameters: { type: "object", properties: {} } } }],
      tool_choice: "auto",
    },
    4096,
  );
  assert.deepEqual(input.system, [{ text: "あなたは親切です" }]);
  assert.equal(input.messages.length, 3);
  assert.deepEqual(input.messages[1], { role: "assistant", content: [{ toolUse: { toolUseId: "c1", name: "time__now", input: { tz: "Asia/Tokyo" } } }] });
  assert.deepEqual(input.messages[2].content, [
    { toolResult: { toolUseId: "c1", content: [{ text: "12:00" }] } },
    { text: "ありがとう" },
  ]);
  assert.equal(input.toolConfig?.tools?.[0].toolSpec?.name, "time__now");
  assert.deepEqual(input.toolConfig?.toolChoice, { auto: {} });
  // 出力の上限はサーバーの MAX_OUTPUT_TOKENS で切る
  assert.equal(input.inferenceConfig.maxTokens, 4096);
});

test("不正な入力は 400 用のエラーにする", () => {
  assert.throws(() => toConverse({ messages: [] }, 10), BadRequest);
  assert.throws(() => toConverse({ messages: [{ role: "assistant", content: "x" }] }, 10), BadRequest);
  assert.throws(() => toConverse({ messages: [{ role: "user", content: [{ type: "image_url" }] }] }, 10), BadRequest);
  assert.throws(() => toConverse({ messages: [{ role: "user", content: "a" }, { role: "tool", content: "x" }] }, 10), BadRequest);
});

test("ConverseStream のイベントを chat.completion.chunk にする", () => {
  const t = new StreamTranslator("m", "id1");
  const out = [
    ...t.next({ messageStart: { role: "assistant" } }),
    ...t.next({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "こん" } } }),
    ...t.next({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "にちは" } } }),
    ...t.next({ contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tu1", name: "f" } } } }),
    ...t.next({ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"a"' } } } }),
    ...t.next({ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: ":1}" } } } }),
    ...t.next({ contentBlockDelta: { contentBlockIndex: 1, delta: { reasoningContent: { text: "考え中" } } } }),
    ...t.next({ messageStop: { stopReason: "tool_use" } }),
    ...t.next({ metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 100 }, metrics: { latencyMs: 1 } } }),
  ] as { choices: { delta: Record<string, unknown>; finish_reason: string | null }[]; usage?: unknown }[];
  assert.equal(out.length, 8);
  assert.deepEqual(out[0].choices[0].delta, { role: "assistant", content: "" });
  assert.equal(t.text, "こんにちは");
  assert.deepEqual(out[3].choices[0].delta, { tool_calls: [{ index: 0, id: "tu1", type: "function", function: { name: "f", arguments: "" } }] });
  assert.deepEqual(out[5].choices[0].delta, { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] });
  assert.equal(out[6].choices[0].finish_reason, "tool_calls");
  assert.deepEqual(out[7].choices, []);
  assert.deepEqual(out[7].usage, {
    prompt_tokens: 110,
    completion_tokens: 5,
    total_tokens: 115,
    prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 },
  });
  assert.deepEqual(t.usage, { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheWriteInputTokens: 0 });
  assert.throws(() => t.next({ throttlingException: { message: "slow down", name: "ThrottlingException", $fault: "client" } as never }));
});

test("非ストリーミングの応答と finish_reason", () => {
  const { body } = completionOf("m", {
    message: { role: "assistant", content: [{ text: "a" }, { toolUse: { toolUseId: "t", name: "f", input: { x: 1 } } }] },
    stopReason: "tool_use",
    usage: { inputTokens: 1, outputTokens: 2 },
  });
  assert.deepEqual(body.choices[0].message, {
    role: "assistant",
    content: "a",
    tool_calls: [{ id: "t", type: "function", function: { name: "f", arguments: '{"x":1}' } }],
  });
  assert.equal(finishReason("max_tokens"), "length");
  assert.equal(finishReason("end_turn"), "stop");
  assert.equal(openAiUsage({ inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 2 }).prompt_tokens, 3);
});

// ---- 料金 ----

test("単価表と料金", () => {
  const table = parsePriceTable(JSON.stringify({ m: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 } }));
  const c = costOf(table.m, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 1_000_000, cacheWriteInputTokens: 0 });
  assert.ok(Math.abs(c.total - (2 + 1 + 0.1)) < 1e-9);
  assert.throws(() => parsePriceTable(JSON.stringify({ m: { input: 1 } })));
  assert.deepEqual(parsePriceTable(undefined), {});
});

// ---- ID トークンの検証 ----

const issuer = "https://idp.example.com/";
const audience = "client-1";

async function signer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? issuer)
      .setAudience(opts.aud ?? audience)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "1h")
      .sign(privateKey);
  return { keys, sign };
}

test("ID トークンの署名・iss・aud・期限・token_use を確かめる", async () => {
  const { keys, sign } = await signer();
  const verify = (t: string) => verifyIdToken(t, { issuer, audience, keys });
  const claims = await verify(await sign({ sub: "auth0|1", name: "太郎" }));
  assert.equal(claims.sub, "auth0|1");
  assert.equal(userNameOfClaims(claims), "太郎");
  assert.equal((await verify(await sign({ sub: "u", token_use: "id" }))).sub, "u");
  await assert.rejects(verify(await sign({ sub: "u", token_use: "access" })));
  await assert.rejects(verify(await sign({ sub: "u" }, { iss: "https://evil.example.com/" })));
  await assert.rejects(verify(await sign({ sub: "u" }, { aud: "other" })));
  await assert.rejects(verify(await sign({ sub: "u" }, { exp: "-10m" })));
  await assert.rejects(verify(await sign({ name: "no sub" })));
  // 別の鍵で署名したもの
  const other = await signer();
  await assert.rejects(verify(await other.sign({ sub: "u" })));
});

test("Bearer の取り出しと、許す範囲 (同じステージの全ルート)", () => {
  assert.equal(bearerToken("Bearer a.b.c"), "a.b.c");
  assert.equal(bearerToken("bearer a.b.c "), "a.b.c");
  assert.equal(bearerToken("Basic abc"), undefined);
  assert.equal(bearerToken(undefined), undefined);
  assert.equal(
    stageWildcard("arn:aws:execute-api:ap-northeast-1:123456789012:abc123/prod/POST/v1/chat/completions"),
    "arn:aws:execute-api:ap-northeast-1:123456789012:abc123/prod/*/*",
  );
});

// ---- プロキシの入口 (AWS を呼ぶ前に断るもの) ----

class Capture extends Writable {
  data = "";
  meta: Record<string, unknown> | undefined;
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.data += chunk.toString();
    cb();
  }
}

test("プロキシ: 未認証は 401、許可リストに無いモデルは 400、知らないルートは 404", async () => {
  // Lambda のランタイムが用意する awslambda の代わり
  (globalThis as Record<string, unknown>).awslambda = {
    HttpResponseStream: { from: (w: Capture, meta: Record<string, unknown>) => ((w.meta = meta), w) },
    streamifyResponse: (h: unknown) => h,
  };
  process.env.MODEL_PRICES = JSON.stringify({ "global.anthropic.claude-sonnet-5-5": { input: 2, output: 10 } });
  const { route } = await import("../src/proxy.ts");
  const call = async (event: Record<string, unknown>) => {
    const w = new Capture();
    await route(event as never, w);
    return { status: w.meta?.statusCode, body: JSON.parse(w.data) };
  };
  const base = { httpMethod: "POST", resource: "/v1/chat/completions", isBase64Encoded: false };
  assert.equal((await call({ ...base, requestContext: { authorizer: {} }, body: "{}" })).status, 401);
  const auth = { requestContext: { authorizer: { sub: "u1" } } };
  const bad = await call({ ...base, ...auth, body: JSON.stringify({ model: "anthropic.claude-opus-x", messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "model_not_allowed");
  assert.equal((await call({ ...base, ...auth, body: "{" })).status, 400);
  assert.equal((await call({ ...base, ...auth, resource: "/v1/other" })).status, 404);
  const ci = await call({ ...base, ...auth, resource: "/v1/code-interpreter/invoke", body: JSON.stringify({ tool: "rm -rf" }) });
  assert.equal(ci.status, 400);
});

test("Code Interpreter のセッション名は利用者ごと (sub は名前に出さない)", async () => {
  const { ownerPrefix, sessionName } = await import("../src/proxy.ts");
  assert.match(sessionName("auth0|1", "3f2b-aa_bb"), /^u[0-9a-f]{24}t3f2baabb$/);
  assert.notEqual(ownerPrefix("auth0|1"), ownerPrefix("auth0|2"));
  assert.ok(!sessionName("auth0|1", "x").includes("auth0"));
});

// ---- トレース (Langfuse の generation) ----

test("traceparent を読む (形が違うもの・ID がすべて 0 のものは使わない)", () => {
  assert.deepEqual(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"), {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    sampled: true,
  });
  assert.equal(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00")?.sampled, false);
  assert.equal(parseTraceparent(undefined), undefined);
  assert.equal(parseTraceparent("00-00000000000000000000000000000000-b7ad6b7169203331-01"), undefined);
  assert.equal(parseTraceparent("garbage"), undefined);
});

const generation = {
  sub: "auth0|u1",
  model: "m",
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  startMs: 1_700_000_000_000,
  endMs: 1_700_000_001_500,
  firstTokenMs: 300,
  usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 700, cacheWriteInputTokens: 0 },
  cost: costOf({ input: 3, output: 15, cache_read: 0.3 }, { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 700, cacheWriteInputTokens: 0 }),
  stream: true,
  stopReason: "end_turn",
};

function attrsOf(body: ReturnType<typeof otlpBody>): Record<string, unknown> {
  const span = body.resourceSpans[0].scopeSpans[0].spans[0];
  return Object.fromEntries(span.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
}

test("generation のスパンをアプリのトレースの子にし、トークン数と台帳の料金を載せる", () => {
  const body = otlpBody(generation, { traceId: "f".repeat(32), spanId: "e".repeat(16) });
  const span = body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.traceId, "0af7651916cd43dd8448eb211c80319c");
  assert.equal(span.parentSpanId, "b7ad6b7169203331");
  assert.equal(span.spanId, "e".repeat(16));
  assert.equal(span.startTimeUnixNano, "1700000000000000000");
  assert.equal(span.endTimeUnixNano, "1700000001500000000");
  const a = attrsOf(body);
  assert.equal(a["langfuse.observation.type"], "generation");
  assert.equal(a["langfuse.user.id"], "auth0|u1");
  assert.deepEqual(JSON.parse(a["langfuse.observation.usage_details"] as string), {
    input: 100,
    output: 20,
    cache_read_input_tokens: 700,
    cache_creation_input_tokens: 0,
  });
  const cost = JSON.parse(a["langfuse.observation.cost_details"] as string);
  assert.ok(Math.abs(cost.total - (100 * 3 + 20 * 15 + 700 * 0.3) / 1e6) < 1e-12);
  assert.equal(a["langfuse.observation.completion_start_time"], new Date(1_700_000_000_300).toISOString());
  assert.equal(a["langfuse.trace.name"], undefined);
  // 本文は渡されたときだけ
  assert.equal(a["langfuse.observation.input"], undefined);
});

test("traceparent が無ければ、このスパンだけのトレースにする。エラーは ERROR にする", () => {
  const body = otlpBody({ ...generation, traceparent: undefined, error: "boom", content: { input: [{ role: "user", content: "hi" }], output: { content: "yo" } } }, {
    traceId: "f".repeat(32),
    spanId: "e".repeat(16),
  });
  const span = body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.traceId, "f".repeat(32));
  assert.equal("parentSpanId" in span, false);
  assert.deepEqual(span.status, { code: 2, message: "boom" });
  const a = attrsOf(body);
  assert.equal(a["langfuse.trace.name"], "llm-proxy");
  assert.equal(a["langfuse.observation.level"], "ERROR");
  assert.equal(a["langfuse.observation.input"], '[{"role":"user","content":"hi"}]');
});

test("Collector に ID トークンを付けて送る。未設定・サンプリング外なら送らない。失敗は理由を返す", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("", { status: calls.length === 1 ? 200 : 401 });
  }) as typeof fetch;
  try {
    assert.equal(await sendGeneration(undefined, "Bearer t", generation), undefined);
    assert.equal(await sendGeneration("https://c/v1/traces", "Bearer t", { ...generation, traceparent: generation.traceparent.replace(/01$/, "00") }), undefined);
    assert.equal(calls.length, 0);
    assert.equal(await sendGeneration("https://c/v1/traces", "Bearer t", generation), undefined);
    assert.equal(calls[0].url, "https://c/v1/traces");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer t");
    assert.equal(await sendGeneration("https://c/v1/traces", "Bearer t", generation), "Collector が 401 を返しました");
    assert.match((await sendGeneration("https://c/v1/traces", undefined, generation)) ?? "", /Authorization/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ヘッダーは大文字小文字を区別せずに探す", () => {
  assert.equal(headerOf({ Authorization: "Bearer a", TraceParent: "x" }, "traceparent"), "x");
  assert.equal(headerOf(null, "authorization"), undefined);
});

test("ストリームのツール呼び出しをトレース用に組み立てる", () => {
  const t = new StreamTranslator("m");
  t.next({ contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "c1", name: "time__now" } } } } as never);
  t.next({ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"tz":' } } } } as never);
  t.next({ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '"UTC"}' } } } } as never);
  assert.deepEqual(t.toolCalls, [{ id: "c1", name: "time__now", arguments: '{"tz":"UTC"}' }]);
});
