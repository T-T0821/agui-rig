// 利用料金の台帳と利用上限。LLM プロキシ (proxy.ts) がモデル呼び出しのたびに料金を足し、
// /usage (usage.ts) と、プロキシの呼び出し前の上限の確認が、ここから読む。
//
// 台帳 (USAGE_TABLE): pk = 利用者の sub、sk = "M#2026-11" (月) / "D#2026-11-22" (日)。
//   costUsd・inputTokens・outputTokens・cacheReadInputTokens・cacheWriteInputTokens・requests を ADD で足す。
//   月と日の区切りは UTC_OFFSET_MINUTES のタイムゾーン (既定 540 = 日本時間)。日の項目は 100 日で TTL で消える
// 上限 (LIMITS_TABLE): pk = sub。管理者 (scripts/limits.ts) が monthlyLimitUsd と resetAt / resetBaseUsd を書く。
//   /usage のたびに Lambda が利用者名と最新の料金を書く (管理者の一覧用)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { TokenUsage } from "./pricing.ts";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** /usage の応答 (アプリの history.rs の Usage と同じ形) */
export type Usage = {
  todayUsd: number;
  monthUsd: number;
  monthStart: string;
  /** 今月の上限 (USD)。上限なしなら null */
  limitUsd: number | null;
  /** 上限の集計を始めた時刻 (月初と、今月の手動リセットの時刻の遅い方) */
  periodStart: string;
  /** periodStart からの料金 (上限と比べる金額) */
  periodUsd: number;
  /** 上限の LIMIT_WARN_RATIO 以上を使った */
  warn: boolean;
  /** 上限に達した (プロキシは新しいモデル呼び出しを断る) */
  blocked: boolean;
};

/** 利用上限テーブルの項目 (pk = sub) */
export type LimitItem = {
  /** 月の上限 (USD)。0 は上限なし。無ければ既定値。管理者が書く */
  monthlyLimitUsd?: number;
  /** 手動リセットの時刻 (ISO 8601)。今月のものなら、ここから数え直す。管理者が書く */
  resetAt?: string;
  /** 手動リセットした時点の今月の料金 (USD)。これを引いた分を上限と比べる。管理者が書く */
  resetBaseUsd?: number;
  // ---- 以下は Lambda が /usage のたびに書く (表示用) ----
  userName?: string;
  lastSeenAt?: string;
  monthUsd?: number;
  periodUsd?: number;
  limitUsd?: number | null;
  blocked?: boolean;
};

const offsetMinutes = () => Number(process.env.UTC_OFFSET_MINUTES ?? 540);

/** 「今日」と「今月」の始まり (UTC_OFFSET_MINUTES のタイムゾーンで区切る) */
export function periodStarts(now: Date, offset: number): { todayStart: Date; monthStart: Date } {
  const ms = offset * 60_000;
  const local = new Date(now.getTime() + ms);
  return {
    todayStart: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - ms),
    monthStart: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - ms),
  };
}

/** 台帳のキー (そのタイムゾーンでの月と日) */
export function ledgerKeys(now: Date, offset: number): { month: string; day: string } {
  const local = new Date(now.getTime() + offset * 60_000).toISOString();
  return { month: `M#${local.slice(0, 7)}`, day: `D#${local.slice(0, 10)}` };
}

/** 上限の金額 (USD)。利用者の設定 → 既定値。0 以下や数でないものは上限なし (null) */
export function resolveLimit(item: LimitItem, defaultLimitUsd: number): number | null {
  const v = typeof item.monthlyLimitUsd === "number" ? item.monthlyLimitUsd : defaultLimitUsd;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** 上限の集計の始まり: 月初と、今月の手動リセットの遅い方 (先月以前・未来・不正な値は無視) */
export function periodStartOf(monthStart: Date, now: Date, resetAt: string | undefined): Date {
  const reset = resetAt ? new Date(resetAt) : undefined;
  if (!reset || Number.isNaN(reset.getTime()) || reset <= monthStart || reset > now) return monthStart;
  return reset;
}

/** 上限との比較 */
export function evaluate(periodUsd: number, limitUsd: number | null, warnRatio: number): { warn: boolean; blocked: boolean } {
  if (limitUsd === null) return { warn: false, blocked: false };
  const blocked = periodUsd >= limitUsd;
  return { blocked, warn: blocked || periodUsd >= limitUsd * warnRatio };
}

/** 台帳の金額と上限の設定から、/usage の応答を作る (純粋な計算。テスト用に分けてある) */
export function summarize(
  now: Date,
  costs: { todayUsd: number; monthUsd: number },
  item: LimitItem,
  opts: { offset: number; defaultLimitUsd: number; warnRatio: number },
): Usage {
  const { monthStart } = periodStarts(now, opts.offset);
  const limitUsd = resolveLimit(item, opts.defaultLimitUsd);
  const periodStart = periodStartOf(monthStart, now, item.resetAt);
  const base = periodStart.getTime() === monthStart.getTime() ? 0 : (item.resetBaseUsd ?? 0);
  const periodUsd = Math.max(0, costs.monthUsd - base);
  return {
    todayUsd: costs.todayUsd,
    monthUsd: costs.monthUsd,
    monthStart: monthStart.toISOString(),
    limitUsd,
    periodStart: periodStart.toISOString(),
    periodUsd,
    ...evaluate(periodUsd, limitUsd, opts.warnRatio),
  };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} がありません`);
  return v;
}

/** 今日と今月の料金 (台帳から) */
async function costs(sub: string, now: Date): Promise<{ todayUsd: number; monthUsd: number }> {
  const table = env("USAGE_TABLE");
  const { month, day } = ledgerKeys(now, offsetMinutes());
  const out = await db.send(
    new BatchGetCommand({
      RequestItems: { [table]: { Keys: [{ pk: sub, sk: month }, { pk: sub, sk: day }], ProjectionExpression: "sk, costUsd" } },
    }),
  );
  const items = out.Responses?.[table] ?? [];
  const cost = (sk: string) => Number(items.find((i) => i.sk === sk)?.costUsd ?? 0);
  return { todayUsd: cost(day), monthUsd: cost(month) };
}

async function limitItem(sub: string): Promise<LimitItem> {
  const out = await db.send(new GetCommand({ TableName: env("LIMITS_TABLE"), Key: { pk: sub } }));
  return (out.Item ?? {}) as LimitItem;
}

/** 利用者の今の利用料金と上限の状態 */
export async function usageOf(sub: string, now = new Date()): Promise<Usage> {
  const [c, item] = await Promise.all([costs(sub, now), limitItem(sub)]);
  return summarize(now, c, item, {
    offset: offsetMinutes(),
    defaultLimitUsd: Number(process.env.DEFAULT_MONTHLY_LIMIT_USD ?? 0),
    warnRatio: Number(process.env.LIMIT_WARN_RATIO ?? 0.8),
  });
}

/** モデル呼び出し 1 回分の料金とトークン数を、今月と今日の項目に足す (ADD なので同時に呼ばれても数え漏れない) */
export async function addUsage(sub: string, model: string, usage: TokenUsage, costUsd: number, now = new Date()): Promise<void> {
  const table = env("USAGE_TABLE");
  const { month, day } = ledgerKeys(now, offsetMinutes());
  const expiresAt = Math.floor(now.getTime() / 1000) + 100 * 86_400;
  const values = {
    ":cost": costUsd,
    ":in": usage.inputTokens,
    ":out": usage.outputTokens,
    ":cr": usage.cacheReadInputTokens,
    ":cw": usage.cacheWriteInputTokens,
    ":one": 1,
    ":now": now.toISOString(),
    ":model": model,
  };
  const add = "ADD costUsd :cost, inputTokens :in, outputTokens :out, cacheReadInputTokens :cr, cacheWriteInputTokens :cw, requests :one";
  await Promise.all([
    db.send(
      new UpdateCommand({
        TableName: table,
        Key: { pk: sub, sk: month },
        UpdateExpression: `${add} SET updatedAt = :now, lastModel = :model`,
        ExpressionAttributeValues: values,
      }),
    ),
    db.send(
      new UpdateCommand({
        TableName: table,
        Key: { pk: sub, sk: day },
        UpdateExpression: `${add} SET updatedAt = :now, lastModel = :model, expiresAt = :exp`,
        ExpressionAttributeValues: { ...values, ":exp": expiresAt },
      }),
    ),
  ]);
}

/** sub・利用者名・最新の料金を上限テーブルに書く (管理者の一覧用)。上限とリセットには触らない。失敗しても応答は返す */
export async function recordSeen(sub: string, userName: string | undefined, usage: Usage): Promise<void> {
  const values: Record<string, unknown> = {
    ":seen": new Date().toISOString(),
    ":month": usage.monthUsd,
    ":period": usage.periodUsd,
    ":limit": usage.limitUsd,
    ":blocked": usage.blocked,
  };
  let set = "lastSeenAt = :seen, monthUsd = :month, periodUsd = :period, limitUsd = :limit, blocked = :blocked";
  if (userName) {
    set += ", userName = :name";
    values[":name"] = userName;
  }
  try {
    await db.send(
      new UpdateCommand({ TableName: env("LIMITS_TABLE"), Key: { pk: sub }, UpdateExpression: `SET ${set}`, ExpressionAttributeValues: values }),
    );
  } catch (e) {
    console.warn("利用状況を記録できません", e);
  }
}
