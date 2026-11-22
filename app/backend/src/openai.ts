// OpenAI 互換の Chat Completions と Bedrock の Converse の変換 (純粋な関数だけ。テストしやすいように proxy.ts から分けてある)。
// アプリの Rig は OpenAI 互換のプロバイダー (base_url = このプロキシ) で呼ぶので、Rig が送る形を受け付ける:
//   messages: system / developer / user / assistant (tool_calls 付き) / tool
//   tools: [{ type: "function", function: { name, description, parameters } }]
//   stream: true のときは SSE (data: {chat.completion.chunk}) で返し、最後に usage の chunk と [DONE]
import type {
  ContentBlock,
  ConverseStreamOutput,
  InferenceConfiguration,
  Message,
  SystemContentBlock,
  ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import type { TokenUsage } from "./pricing.ts";

export type ChatMessage = {
  role: string;
  content?: string | null | { type: string; text?: string }[];
  tool_calls?: { id: string; type?: string; function: { name: string; arguments?: string } }[];
  tool_call_id?: string;
};

export type ChatRequest = {
  model?: string;
  messages?: ChatMessage[];
  tools?: { type: string; function?: { name: string; description?: string; parameters?: unknown } }[];
  tool_choice?: string | { type: string; function?: { name: string } };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
};

export class BadRequest extends Error {}

export type ConverseInput = {
  system: SystemContentBlock[];
  messages: Message[];
  toolConfig?: ToolConfiguration;
  inferenceConfig: InferenceConfiguration;
};

function textOf(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new BadRequest("content の形が不正です");
  return content
    .map((p) => {
      if (p?.type === "text" && typeof p.text === "string") return p.text;
      throw new BadRequest(`content の種類 ${String(p?.type)} には対応していません (text だけ)`);
    })
    .join("");
}

function parseArguments(args: string | undefined): Record<string, unknown> {
  if (!args || args.trim() === "") return {};
  try {
    const v = JSON.parse(args);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    throw new BadRequest("tool_calls の arguments が JSON ではありません");
  }
}

/**
 * Chat Completions のリクエストを Converse の入力に変える。
 * Bedrock は user と assistant が交互でないと受け付けないので、同じ役割が続くときは 1 つにまとめる
 * (tool の結果は user 側の toolResult になる)。空のテキストは送らない (Bedrock が断るため)。
 */
export function toConverse(req: ChatRequest, maxOutputTokens: number): ConverseInput {
  if (!Array.isArray(req.messages) || req.messages.length === 0) throw new BadRequest("messages がありません");
  const system: SystemContentBlock[] = [];
  const messages: Message[] = [];
  const push = (role: "user" | "assistant", blocks: ContentBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content = [...(last.content ?? []), ...blocks];
    else messages.push({ role, content: blocks });
  };

  for (const m of req.messages) {
    switch (m.role) {
      case "system":
      case "developer": {
        const text = textOf(m.content);
        if (text.trim()) system.push({ text });
        break;
      }
      case "user": {
        const text = textOf(m.content);
        push("user", text.trim() ? [{ text }] : []);
        break;
      }
      case "assistant": {
        const blocks: ContentBlock[] = [];
        const text = textOf(m.content);
        if (text.trim()) blocks.push({ text });
        for (const call of m.tool_calls ?? []) {
          if (!call?.id || !call.function?.name) throw new BadRequest("tool_calls に id と function.name が要ります");
          blocks.push({ toolUse: { toolUseId: call.id, name: call.function.name, input: parseArguments(call.function.arguments) as never } });
        }
        push("assistant", blocks);
        break;
      }
      case "tool": {
        if (!m.tool_call_id) throw new BadRequest("tool のメッセージに tool_call_id がありません");
        const text = textOf(m.content);
        push("user", [{ toolResult: { toolUseId: m.tool_call_id, content: [{ text: text || "(空)" }] } }]);
        break;
      }
      default:
        throw new BadRequest(`role ${m.role} には対応していません`);
    }
  }
  if (messages[0]?.role !== "user") throw new BadRequest("最初のメッセージは user にしてください");

  let toolConfig: ToolConfiguration | undefined;
  const tools = (req.tools ?? []).filter((t) => t?.type === "function" && t.function?.name);
  if (tools.length > 0 && req.tool_choice !== "none") {
    toolConfig = {
      tools: tools.map((t) => ({
        toolSpec: {
          name: t.function!.name,
          description: t.function!.description || t.function!.name,
          inputSchema: { json: (t.function!.parameters ?? { type: "object", properties: {} }) as never },
        },
      })),
    };
    const choice = req.tool_choice;
    if (choice === "required") toolConfig.toolChoice = { any: {} };
    else if (typeof choice === "object" && choice?.function?.name) toolConfig.toolChoice = { tool: { name: choice.function.name } };
    else if (choice === "auto") toolConfig.toolChoice = { auto: {} };
  }

  // 出力の上限は、リクエストの値と MAX_OUTPUT_TOKENS の小さい方 (1 回で使える料金の上限を抑えるため)
  const requested = req.max_completion_tokens ?? req.max_tokens;
  const inferenceConfig: InferenceConfiguration = {
    maxTokens: Math.max(1, Math.min(typeof requested === "number" && requested > 0 ? requested : maxOutputTokens, maxOutputTokens)),
  };
  if (typeof req.temperature === "number") inferenceConfig.temperature = req.temperature;
  if (typeof req.top_p === "number") inferenceConfig.topP = req.top_p;
  if (req.stop) inferenceConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  return { system, messages, toolConfig, inferenceConfig };
}

/** Bedrock の stopReason → OpenAI の finish_reason */
export function finishReason(stopReason: string | undefined): string {
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "guardrail_intervened":
    case "content_filtered":
      return "content_filter";
    default:
      return "stop";
  }
}

/** Bedrock の usage → OpenAI の usage (prompt_tokens はキャッシュの読み書きを含めた入力の合計) */
export function openAiUsage(u: TokenUsage) {
  const prompt = u.inputTokens + u.cacheReadInputTokens + u.cacheWriteInputTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.outputTokens,
    total_tokens: prompt + u.outputTokens,
    prompt_tokens_details: { cached_tokens: u.cacheReadInputTokens, cache_write_tokens: u.cacheWriteInputTokens },
  };
}

export function tokenUsageOf(u: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number } | undefined): TokenUsage {
  return {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadInputTokens: u?.cacheReadInputTokens ?? 0,
    cacheWriteInputTokens: u?.cacheWriteInputTokens ?? 0,
  };
}

/**
 * ConverseStream のイベントを、OpenAI の chat.completion.chunk に変える。
 * 1 回のストリームにつき 1 つ作って、イベントを順に `next` に渡す。返す配列の各要素が SSE の data 1 件。
 * ツール呼び出しは、Bedrock の contentBlockIndex ごとに OpenAI の tool_calls[].index を 0 から振る。
 */
export class StreamTranslator {
  readonly id: string;
  readonly created = Math.floor(Date.now() / 1000);
  private toolIndex = new Map<number, number>();
  /** 回答のテキスト (トレース用) */
  text = "";
  stopReason: string | undefined;
  usage: TokenUsage | undefined;

  readonly model: string;

  constructor(model: string, id = `chatcmpl-${crypto.randomUUID()}`) {
    this.model = model;
    this.id = id;
  }

  private chunk(delta: Record<string, unknown>, finish: string | null = null) {
    return { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }] };
  }

  next(event: ConverseStreamOutput): object[] {
    if (event.messageStart) return [this.chunk({ role: "assistant", content: "" })];
    if (event.contentBlockStart?.start?.toolUse) {
      const { toolUseId, name } = event.contentBlockStart.start.toolUse;
      const index = this.toolIndex.size;
      this.toolIndex.set(event.contentBlockStart.contentBlockIndex ?? 0, index);
      return [this.chunk({ tool_calls: [{ index, id: toolUseId, type: "function", function: { name, arguments: "" } }] })];
    }
    if (event.contentBlockDelta?.delta) {
      const { delta, contentBlockIndex } = event.contentBlockDelta;
      if (typeof delta.text === "string" && delta.text !== "") {
        this.text += delta.text;
        return [this.chunk({ content: delta.text })];
      }
      if (delta.toolUse?.input) {
        const index = this.toolIndex.get(contentBlockIndex ?? 0) ?? 0;
        return [this.chunk({ tool_calls: [{ index, function: { arguments: delta.toolUse.input } }] })];
      }
      // 推論 (reasoningContent) は返さない (Rig が次の要求に入れ直すと、Bedrock は署名なしの推論を受け付けないため)
      return [];
    }
    if (event.messageStop) {
      this.stopReason = event.messageStop.stopReason;
      return [this.chunk({}, finishReason(this.stopReason))];
    }
    if (event.metadata) {
      this.usage = tokenUsageOf(event.metadata.usage);
      return [{ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [], usage: openAiUsage(this.usage) }];
    }
    const err =
      event.internalServerException ?? event.modelStreamErrorException ?? event.validationException ?? event.throttlingException ?? event.serviceUnavailableException;
    if (err) throw new Error(err.message ?? "Bedrock のストリームでエラーが起きました");
    return [];
  }
}

/** 非ストリーミングの Converse の応答 → chat.completion */
export function completionOf(
  model: string,
  output: { message?: Message; stopReason?: string; usage?: Parameters<typeof tokenUsageOf>[0] },
) {
  const blocks = output.message?.content ?? [];
  const text = blocks.map((b) => b.text ?? "").join("");
  const toolCalls = blocks
    .filter((b) => b.toolUse)
    .map((b) => ({ id: b.toolUse!.toolUseId, type: "function", function: { name: b.toolUse!.name, arguments: JSON.stringify(b.toolUse!.input ?? {}) } }));
  const usage = tokenUsageOf(output.usage);
  return {
    body: {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
          finish_reason: finishReason(output.stopReason),
        },
      ],
      usage: openAiUsage(usage),
    },
    text,
    usage,
  };
}
