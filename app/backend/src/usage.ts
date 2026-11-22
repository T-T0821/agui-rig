// 利用料金: API Gateway (REST API + ID トークンのオーソライザー) → この Lambda → DynamoDB
//   GET /usage  呼び出した利用者 (sub) の今日と今月の料金と、利用上限の状態
// 料金は LLM プロキシ (proxy.ts) が Bedrock の応答のトークン数から計算して台帳に足したもの
// (アプリの自己申告や Langfuse の集計ではないので、遅れずに正しい)。計算は ledger.ts。
// 呼ばれるたびに、上限テーブルへ sub・利用者名 (検証済みの ID トークンのクレーム)・最新の料金を書く
// (管理者が pnpm limits list で誰がいくら使っているかを見られるように)。
import { type Event, type Result, error, json, subOf, userNameOf } from "./http.ts";
import { recordSeen, usageOf } from "./ledger.ts";

export async function handler(event: Event): Promise<Result> {
  const sub = subOf(event);
  if (!sub) return error(401, "Unauthorized");
  const usage = await usageOf(sub);
  await recordSeen(sub, userNameOf(event), usage);
  return json(200, usage);
}
