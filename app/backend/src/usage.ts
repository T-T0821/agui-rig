// 利用料金: API Gateway (JWT オーソライザー) → この Lambda (VPC 内) → Langfuse の集計 API
//   GET /usage  呼び出した利用者 (sub) の今日と今月の料金
// Langfuse のキーはこの Lambda だけが持つ (アプリには渡さない)。
// @aws-sdk/* は Lambda の Node.js ランタイムに入っているので、まとめずに外から読む。
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { type Event, type Result, error, json, subOf } from "./http.ts";

/** 応答 */
type Usage = { todayUsd: number; monthUsd: number; monthStart: string };

/** Langfuse の /api/public/metrics/daily の応答 (使う所だけ) */
type DailyMetrics = {
  data?: { date: string; totalCost?: number }[];
  meta?: { page: number; totalPages: number };
};

type LangfuseKeys = { publicKey: string; secretKey: string };

const secrets = new SecretsManagerClient({});
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

export async function handler(event: Event): Promise<Result> {
  const sub = subOf(event);
  if (!sub) return error(401, "Unauthorized");
  const now = new Date();
  const { todayStart, monthStart } = periodStarts(now, Number(process.env.UTC_OFFSET_MINUTES ?? 0));
  const [todayUsd, monthUsd] = await Promise.all([costBetween(sub, todayStart, now), costBetween(sub, monthStart, now)]);
  const usage: Usage = { todayUsd, monthUsd, monthStart: monthStart.toISOString() };
  return json(200, usage);
}
