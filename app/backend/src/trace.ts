// LLM プロキシのモデル呼び出しを、Langfuse の generation として OTel Collector に送る。
//
//   プロキシ (この Lambda) ─(OTLP/HTTP JSON + Authorization: Bearer <利用者の ID トークン>)→ Collector → Langfuse
//
// - 認証はアプリと同じ ID トークン (アプリがプロキシに付けてきたもの) をそのまま使う。Collector の oidc 認証が検証し、
//   langfuse.user.id を検証済みの sub で上書きするので、プロキシに Langfuse のキーや新しい秘密は要らない
// - アプリが W3C の traceparent ヘッダーを付けてきたら、その子スパンにする (Langfuse ではアプリのトレースの中に並ぶ)。
//   無ければ、このスパンだけのトレースになる
// - トークン数と料金はここ (台帳と同じ単価) で載せる。アプリ側のスパンには載せない (二重計上を避ける)
// - プロンプトと回答の本文は PROXY_TRACE_CONTENT=true のときだけ入れる
// - 送れなくてもチャットは止めない (ログだけ残す)。応答を返し終えてから送るので、利用者は待たない
import { randomBytes } from "node:crypto";
import type { Cost, TokenUsage } from "./pricing.ts";

/** W3C Trace Context の traceparent (version 00) から、親のトレース ID とスパン ID を取り出す */
export function parseTraceparent(header: string | undefined): { traceId: string; spanId: string; sampled: boolean } | undefined {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec((header ?? "").trim().toLowerCase());
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return undefined;
  return { traceId: m[1], spanId: m[2], sampled: (parseInt(m[3], 16) & 1) === 1 };
}

export type Generation = {
  /** ID トークンの sub (Collector でも上書きされる) */
  sub: string;
  model: string;
  traceparent: string | undefined;
  startMs: number;
  endMs: number;
  /** 最初のトークンが出た時刻 (ストリーミングのとき) */
  firstTokenMs?: number;
  usage: TokenUsage;
  cost: Cost;
  stream: boolean;
  stopReason?: string;
  error?: string;
  /** PROXY_TRACE_CONTENT=true のときだけ渡す */
  content?: { input: unknown; output: unknown };
};

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

function value(v: string | number | boolean): AnyValue {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}

const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

/** Langfuse のトークン数の区分 (アプリが今まで使っていたキーと同じ。モデル定義の単価もこのキーに付ける) */
export function usageDetails(u: TokenUsage): Record<string, number> {
  return {
    input: u.inputTokens,
    output: u.outputTokens,
    cache_read_input_tokens: u.cacheReadInputTokens,
    cache_creation_input_tokens: u.cacheWriteInputTokens,
  };
}

/** 料金の内訳 (台帳と同じ単価で計算したもの。Langfuse はこれがあるとモデル定義の単価を使わない) */
export function costDetails(c: Cost): Record<string, number> {
  return { input: c.input, output: c.output, cache_read_input_tokens: c.cacheRead, cache_creation_input_tokens: c.cacheWrite, total: c.total };
}

/** OTLP/HTTP (JSON) の本文。スパンは 1 つ (generation) */
export function otlpBody(g: Generation, ids = { traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") }) {
  const parent = parseTraceparent(g.traceparent);
  const traceId = parent?.traceId ?? ids.traceId;
  const attrs: Record<string, string | number | boolean> = {
    "langfuse.observation.type": "generation",
    "langfuse.observation.model.name": g.model,
    "langfuse.observation.usage_details": JSON.stringify(usageDetails(g.usage)),
    "langfuse.observation.cost_details": JSON.stringify(costDetails(g.cost)),
    "langfuse.observation.metadata.stream": g.stream,
    "langfuse.user.id": g.sub,
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "aws.bedrock",
    "gen_ai.request.model": g.model,
    "gen_ai.response.model": g.model,
  };
  if (!parent) attrs["langfuse.trace.name"] = "llm-proxy";
  if (g.stopReason) attrs["gen_ai.response.finish_reasons"] = JSON.stringify([g.stopReason]);
  if (g.firstTokenMs !== undefined) attrs["langfuse.observation.completion_start_time"] = new Date(g.startMs + g.firstTokenMs).toISOString();
  if (g.error) {
    attrs["langfuse.observation.level"] = "ERROR";
    attrs["langfuse.observation.status_message"] = g.error;
  }
  if (g.content) {
    attrs["langfuse.observation.input"] = JSON.stringify(g.content.input);
    attrs["langfuse.observation.output"] = JSON.stringify(g.content.output);
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: value("agui-llm-proxy") }] },
        scopeSpans: [
          {
            scope: { name: "agui-llm-proxy" },
            spans: [
              {
                traceId,
                spanId: ids.spanId,
                ...(parent ? { parentSpanId: parent.spanId } : {}),
                name: `chat ${g.model}`,
                kind: 3, // CLIENT (Bedrock を呼ぶ側)
                startTimeUnixNano: nanos(g.startMs),
                endTimeUnixNano: nanos(g.endMs),
                attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: value(v) })),
                status: g.error ? { code: 2, message: g.error } : { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Collector に送る。endpoint は `https://<Collector>/v1/traces` の形 (未設定なら何もしない)。
 * authorization はアプリから届いた Authorization ヘッダー (Bearer <ID トークン>) そのもの。
 * 失敗しても例外は投げず、理由を返す (呼び出し元がログに出す)。
 */
export async function sendGeneration(
  endpoint: string | undefined,
  authorization: string | undefined,
  g: Generation,
  timeoutMs = 3000,
): Promise<string | undefined> {
  if (!endpoint) return undefined;
  if (!authorization) return "Authorization ヘッダーが無いため送りません";
  const parent = parseTraceparent(g.traceparent);
  // アプリ側でサンプリングから外れたトレースには足さない
  if (parent && !parent.sampled) return undefined;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(otlpBody(g)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return `Collector が ${res.status} を返しました`;
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** API Gateway のヘッダーは大文字小文字がそのまま来るので、名前を小文字で比べて探す */
export function headerOf(headers: Record<string, string | undefined> | null | undefined, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === want && v) return v;
  return undefined;
}
