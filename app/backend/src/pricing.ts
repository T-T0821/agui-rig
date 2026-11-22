// モデルの単価と料金の計算。単価は Terraform の model_prices から環境変数 MODEL_PRICES (JSON) で渡す。
// ここに載っているモデルだけをプロキシで呼べる (料金が分からないモデルは上限を守れないため、許可リストを兼ねる)。

/** 100 万トークンあたりの USD */
export type ModelPrice = { input: number; output: number; cache_read?: number; cache_write?: number };
export type PriceTable = Record<string, ModelPrice>;

/** Bedrock の Converse が返すトークン数 (inputTokens はキャッシュの読み書きを含まない) */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
};

export type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };

export function parsePriceTable(json: string | undefined): PriceTable {
  if (!json) return {};
  const raw = JSON.parse(json) as Record<string, Partial<ModelPrice>>;
  const table: PriceTable = {};
  for (const [model, p] of Object.entries(raw)) {
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    const input = n(p.input);
    const output = n(p.output);
    if (input === undefined || output === undefined) throw new Error(`MODEL_PRICES の ${model} に input と output がありません`);
    table[model] = { input, output, cache_read: n(p.cache_read) ?? 0, cache_write: n(p.cache_write) ?? 0 };
  }
  return table;
}

export function costOf(price: ModelPrice, u: TokenUsage): Cost {
  const per = (tokens: number, usdPerMillion = 0) => (tokens * usdPerMillion) / 1_000_000;
  const input = per(u.inputTokens, price.input);
  const output = per(u.outputTokens, price.output);
  const cacheRead = per(u.cacheReadInputTokens, price.cache_read);
  const cacheWrite = per(u.cacheWriteInputTokens, price.cache_write);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
