// 本物の AWS への疎通確認。アプリが使うサービスを 1 つずつ最小の呼び出しで確かめる。
//
//   AWS_PROFILE=my-dev AWS_REGION=ap-northeast-1 pnpm smoke:aws   (リポジトリのルートで)
//
// 使う認証は AWS SDK 標準 (AWS_PROFILE / SSO / 環境変数のキーなど)。`pnpm dev:aws` と同じ。
// 確かめること:
//   1. STS          … 認証情報が有効か (GetCallerIdentity)
//   2. Bedrock      … BEDROCK_MODEL_ID のモデルを呼べるか (最大 16 トークンだけ。数円未満の費用がかかる)
//   3. AgentCore    … Code Interpreter のセッションを開始 → print(1 + 1) を実行 → 終了 (CODE_INTERPRETER_ID=off で省略)
//   4. API Gateway  … CHAT_API_URL があれば、トークンなしで 401 になる (JWT オーソライザーが効いている) こと。
//                      ID_TOKEN (ログインで得た ID トークン) も渡せば、/threads と /usage が 200 になること
// 設定は環境変数のほか、app/desktop/.env とルートの .env.cloud も読む (環境変数が優先)。
// pnpm dev-env up で自分の開発環境を作っていれば、CHAT_API_URL は .env.cloud から入る。

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { ConverseCommand, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockAgentCoreClient,
  InvokeCodeInterpreterCommand,
  StartCodeInterpreterSessionCommand,
  StopCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { loadCloudEnv } from "../dev/env-file.mjs";

// app/desktop/.env と、ルートの .env.cloud (pnpm dev-env up が書く接続先) も読む。環境変数が優先
loadCloudEnv(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"));
loadCloudEnv();

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "ap-northeast-1";
const modelId = process.env.BEDROCK_MODEL_ID || "global.anthropic.claude-sonnet-5-5";
const codeInterpreterId = process.env.CODE_INTERPRETER_ID || "aws.codeinterpreter.v1";
const chatApiUrl = process.env.CHAT_API_URL?.replace(/\/$/, "");
const idToken = process.env.ID_TOKEN;

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    if (detail === SKIP) {
      results.push({ name, status: "SKIP" });
      console.log(`- ${name}: 省略`);
      return;
    }
    results.push({ name, status: "OK" });
    console.log(`✓ ${name} (${Date.now() - started} ms)${detail ? `: ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, status: "NG" });
    console.log(`✗ ${name}: ${e.name ?? "Error"}: ${e.message}`);
  }
}
const SKIP = Symbol("skip");

console.log(`リージョン: ${region} / モデル: ${modelId}\n`);

await check("STS: 認証情報", async () => {
  const id = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
  return `${id.Arn}`;
});

await check("Bedrock: モデル呼び出し", async () => {
  const r = await new BedrockRuntimeClient({ region }).send(
    new ConverseCommand({
      modelId,
      messages: [{ role: "user", content: [{ text: "「OK」とだけ返してください。" }] }],
      inferenceConfig: { maxTokens: 16 },
    }),
  );
  const text = r.output?.message?.content?.map((c) => c.text ?? "").join("").trim();
  return `「${text}」 (入力 ${r.usage?.inputTokens} / 出力 ${r.usage?.outputTokens} トークン)`;
});

await check("AgentCore: Code Interpreter", async () => {
  if (codeInterpreterId === "off") return SKIP;
  const client = new BedrockAgentCoreClient({ region });
  const { sessionId } = await client.send(
    new StartCodeInterpreterSessionCommand({ codeInterpreterIdentifier: codeInterpreterId, name: "smoke-test", sessionTimeoutSeconds: 120 }),
  );
  try {
    const r = await client.send(
      new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: codeInterpreterId,
        sessionId,
        name: "executeCode",
        arguments: { language: "python", code: "print(1 + 1)" },
      }),
    );
    let stdout = "";
    for await (const event of r.stream) {
      if (event.result) stdout += event.result.structuredContent?.stdout ?? "";
      for (const [key, value] of Object.entries(event)) {
        if (key !== "result" && value?.message) throw new Error(`${key}: ${value.message}`);
      }
    }
    if (stdout.trim() !== "2") throw new Error(`出力が想定と違います: ${JSON.stringify(stdout)}`);
    return `print(1 + 1) → ${stdout.trim()}`;
  } finally {
    await client.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: codeInterpreterId, sessionId }));
  }
});

await check("API Gateway: トークンなしは 401", async () => {
  if (!chatApiUrl) return SKIP;
  const r = await fetch(`${chatApiUrl}/threads`);
  if (r.status !== 401) throw new Error(`HTTP ${r.status} (401 のはず)`);
  return `${chatApiUrl}/threads → 401`;
});

for (const path of ["/threads", "/usage"]) {
  await check(`API Gateway: ${path} (ID トークン)`, async () => {
    if (!chatApiUrl || !idToken) return SKIP;
    const r = await fetch(`${chatApiUrl}${path}`, { headers: { Authorization: `Bearer ${idToken}` } });
    // /usage は利用料金の機能を作っていなければ 404 (アプリも 404 は「機能なし」として扱う)
    if (path === "/usage" && r.status === 404) return "404 (利用料金の機能なし)";
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const body = await r.json();
    return Array.isArray(body) ? `${body.length} 件` : JSON.stringify(body).slice(0, 160);
  });
}

const ng = results.filter((r) => r.status === "NG").length;
const ok = results.filter((r) => r.status === "OK").length;
console.log(`\nOK ${ok} 件 / NG ${ng} 件 / 省略 ${results.length - ok - ng} 件`);
process.exit(ng ? 1 : 0);
