// AppSync から { sub } だけを受け取り、その利用者の料金だけを返す。
// Langfuse のキーはこの Lambda だけが持つ (アプリには渡さない)。
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const secrets = new SecretsManagerClient({});
let authHeader;

async function auth() {
  if (!authHeader) {
    const s = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.LANGFUSE_SECRET_ARN }));
    const { publicKey, secretKey } = JSON.parse(s.SecretString);
    authHeader = "Basic " + Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  }
  return authHeader;
}

// 期間内の料金の合計 (Langfuse の日次集計 API。ページをたどる)
async function costBetween(sub, from, to) {
  let total = 0;
  for (let page = 1; page <= 20; page++) {
    const url = new URL("/api/public/metrics/daily", process.env.LANGFUSE_HOST);
    url.search = new URLSearchParams({
      userId: sub, fromTimestamp: from.toISOString(), toTimestamp: to.toISOString(), page: String(page), limit: "100",
    });
    const res = await fetch(url, { headers: { Authorization: await auth() } });
    if (!res.ok) throw new Error(`Langfuse: ${res.status}`);
    const body = await res.json();
    total += (body.data ?? []).reduce((sum, d) => sum + (d.totalCost ?? 0), 0);
    if (page >= (body.meta?.totalPages ?? 1)) break;
  }
  return total;
}

exports.handler = async (event) => {
  const sub = event.sub;
  if (!sub) throw new Error("Unauthorized");
  const offset = Number(process.env.UTC_OFFSET_MINUTES ?? 0) * 60_000;
  const now = new Date();
  const local = new Date(now.getTime() + offset);
  const todayStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset);
  const monthStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offset);
  const [todayUsd, monthUsd] = await Promise.all([costBetween(sub, todayStart, now), costBetween(sub, monthStart, now)]);
  return { todayUsd, monthUsd, monthStart: monthStart.toISOString() };
};
