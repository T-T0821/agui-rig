// 利用料金: API Gateway (JWT オーソライザー) → この Lambda (VPC 内) → Langfuse の集計 API
//   GET /usage  呼び出した利用者 (sub) の今日と今月の料金と、利用上限の状態
// Langfuse のキーはこの Lambda だけが持つ (アプリには渡さない)。
// 利用上限は DynamoDB (LIMITS_TABLE) の利用者ごとの設定、無ければ DEFAULT_MONTHLY_LIMIT_USD。
// 上限は月ごと (UTC_OFFSET_MINUTES の月初) に自動で戻り、管理者が resetAt を入れるとその時点から数え直す
// (scripts/limits.ts)。
// @aws-sdk/* は Lambda の Node.js ランタイムに入っているので、まとめずに外から読む。
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { type Event, type Result, error, json, subOf } from "./http.ts";

/** 応答 */
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
  /** 上限に達した (アプリは新しい実行を止める) */
  blocked: boolean;
};

/** 利用上限テーブルの項目 (pk = sub) */
export type LimitItem = {
  /** 月の上限 (USD)。0 は上限なし。無ければ既定値 */
  monthlyLimitUsd?: number;
  /** 手動リセットの時刻 (ISO 8601)。今月のものなら、ここから数え直す */
  resetAt?: string;
};

/** Langfuse の /api/public/metrics/daily の応答 (使う所だけ) */
type DailyMetrics = {
  data?: { date: string; totalCost?: number }[];
  meta?: { page: number; totalPages: number };
};

type LangfuseKeys = { publicKey: string; secretKey: string };

const secrets = new SecretsManagerClient({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
let authHeader: string | undefined;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} がありません`);
  return v;
}

/** Langfuse の Basic 認証ヘッダー。シークレットは最初の 1 回だけ読む */
async function auth(): Promise<string> {
  if (!authHeader) {
    const s = await secrets.send(new GetSecretValueCommand({ SecretId: env("LANGFUSE_SECRET_ARN") }));
    const { publicKey, secretKey } = JSON.parse(s.SecretString ?? "{}") as Partial<LangfuseKeys>;
    if (!publicKey || !secretKey) throw new Error("シークレットに publicKey と secretKey がありません");
    authHeader = "Basic " + Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  }
  return authHeader;
}

/** 期間内の料金の合計 (Langfuse の日次集計 API。ページをたどる) */
async function costBetween(sub: string, from: Date, to: Date): Promise<number> {
  let total = 0;
  for (let page = 1; page <= 20; page++) {
    const url = new URL("/api/public/metrics/daily", env("LANGFUSE_HOST"));
    url.search = new URLSearchParams({
      userId: sub,
      fromTimestamp: from.toISOString(),
      toTimestamp: to.toISOString(),
      page: String(page),
      limit: "100",
    }).toString();
    const res = await fetch(url, { headers: { Authorization: await auth() } });
    if (!res.ok) throw new Error(`Langfuse: ${res.status}`);
    const body = (await res.json()) as DailyMetrics;
    total += (body.data ?? []).reduce((sum, d) => sum + (d.totalCost ?? 0), 0);
    if (page >= (body.meta?.totalPages ?? 1)) break;
  }
  return total;
}

/** 「今日」と「今月」の始まり (UTC_OFFSET_MINUTES のタイムゾーンで区切る) */
export function periodStarts(now: Date, offsetMinutes: number): { todayStart: Date; monthStart: Date } {
  const offset = offsetMinutes * 60_000;
  const local = new Date(now.getTime() + offset);
  return {
    todayStart: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset),
    monthStart: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offset),
  };
}

/** 利用者の上限の設定。LIMITS_TABLE が無ければ空 (既定値だけを使う) */
async function limitItem(sub: string): Promise<LimitItem> {
  const table = process.env.LIMITS_TABLE;
  if (!table) return {};
  const out = await db.send(new GetCommand({ TableName: table, Key: { pk: sub } }));
  return (out.Item ?? {}) as LimitItem;
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

export async function handler(event: Event): Promise<Result> {
  const sub = subOf(event);
  if (!sub) return error(401, "Unauthorized");
  const now = new Date();
  const { todayStart, monthStart } = periodStarts(now, Number(process.env.UTC_OFFSET_MINUTES ?? 0));
  const [todayUsd, monthUsd, item] = await Promise.all([
    costBetween(sub, todayStart, now),
    costBetween(sub, monthStart, now),
    limitItem(sub),
  ]);
  const limitUsd = resolveLimit(item, Number(process.env.DEFAULT_MONTHLY_LIMIT_USD ?? 0));
  const periodStart = periodStartOf(monthStart, now, item.resetAt);
  // 今月手動でリセットされていれば、リセット後の分だけを数える
  const periodUsd = periodStart.getTime() === monthStart.getTime() ? monthUsd : await costBetween(sub, periodStart, now);
  const usage: Usage = {
    todayUsd,
    monthUsd,
    monthStart: monthStart.toISOString(),
    limitUsd,
    periodStart: periodStart.toISOString(),
    periodUsd,
    ...evaluate(periodUsd, limitUsd, Number(process.env.LIMIT_WARN_RATIO ?? 0.8)),
  };
  return json(200, usage);
}
