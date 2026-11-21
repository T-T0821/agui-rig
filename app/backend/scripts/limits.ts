// 利用上限の管理 (管理者用 CLI)。管理者の AWS 認証情報 (AWS_PROFILE など) で DynamoDB を直接読み書きする。
// アプリや API Gateway からは変えられない (利用者が自分の上限を変えられないように)。
//
//   npm run limits -- list                 利用者の一覧 (sub・利用者名・今月の料金・上限)
//   npm run limits -- get     <sub>        1 人の設定
//   npm run limits -- set     <sub> <USD>  その人の月の上限 (0 = 上限なし)
//   npm run limits -- unset   <sub>        その人の上限を消して既定値 (default_monthly_limit_usd) に戻す
//   npm run limits -- reset   <sub>        今この時点から数え直す (今月のここまでの使用額を 0 として扱う)
//   npm run limits -- unreset <sub>        手動リセットを取り消す (月初から数える)
//
// テーブル名は LIMITS_TABLE (terraform output -raw limits_table_name)。
// <sub> は ID トークンの sub (Auth0 の user_id、例 "auth0|abc..."。Langfuse の User ID と同じ)。
// 月初には何もしなくても自動で数え直される (Lambda は月初からの料金と上限を比べるため)。
// userName・lastSeenAt・monthUsd などは、アプリが /usage を呼ぶたびに Lambda が書く (表示用、ここでは変えない)。
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const table = process.env.LIMITS_TABLE;
const [command, sub, value] = process.argv.slice(2);
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function usage(): never {
  console.error("使い方: npm run limits -- <list | get <sub> | set <sub> <USD> | unset <sub> | reset <sub> | unreset <sub>>");
  process.exit(2);
}

async function setAttribute(pk: string, name: string, v: unknown): Promise<void> {
  await db.send(
    new UpdateCommand({
      TableName: table,
      Key: { pk },
      UpdateExpression: "SET #a = :v, updatedAt = :now",
      ExpressionAttributeNames: { "#a": name },
      ExpressionAttributeValues: { ":v": v, ":now": new Date().toISOString() },
    }),
  );
}

/** 属性を消す (項目は残す。利用者名などの記録があるため) */
async function removeAttribute(pk: string, name: string): Promise<void> {
  await db.send(
    new UpdateCommand({
      TableName: table,
      Key: { pk },
      UpdateExpression: "REMOVE #a SET updatedAt = :now",
      ExpressionAttributeNames: { "#a": name },
      ExpressionAttributeValues: { ":now": new Date().toISOString() },
    }),
  );
}

const usd = (v: unknown) => (typeof v === "number" ? `$${v.toFixed(2)}` : "-");

async function main(): Promise<void> {
  if (!table) {
    console.error("LIMITS_TABLE を設定してください (terraform output -raw limits_table_name)");
    process.exit(2);
  }
  if (command !== "list" && !sub) usage();
  switch (command) {
    case "list": {
      let key: Record<string, unknown> | undefined;
      do {
        const out = await db.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }));
        for (const i of out.Items ?? []) {
          const limit = typeof i.monthlyLimitUsd === "number" ? (i.monthlyLimitUsd === 0 ? "上限なし" : usd(i.monthlyLimitUsd)) : "既定";
          console.log(
            [i.pk, i.userName ?? "-", `今月 ${usd(i.monthUsd)}`, `上限との比較 ${usd(i.periodUsd)}`, `上限 ${limit}`,
              i.blocked ? "到達" : "", i.resetAt ? `リセット ${i.resetAt}` : "", `最終 ${i.lastSeenAt ?? "-"}`]
              .filter(Boolean)
              .join("\t"),
          );
        }
        key = out.LastEvaluatedKey;
      } while (key);
      return;
    }
    case "get": {
      const out = await db.send(new GetCommand({ TableName: table, Key: { pk: sub } }));
      console.log(out.Item ? JSON.stringify(out.Item, null, 2) : "設定なし (既定の上限を使います)");
      return;
    }
    case "set": {
      const usd = Number(value);
      if (value === undefined || !Number.isFinite(usd) || usd < 0) usage();
      await setAttribute(sub, "monthlyLimitUsd", usd);
      console.log(usd === 0 ? `${sub}: 上限なし` : `${sub}: 月の上限 $${usd}`);
      return;
    }
    case "unset":
      await removeAttribute(sub, "monthlyLimitUsd");
      console.log(`${sub}: 既定の上限に戻しました`);
      return;
    case "reset": {
      const now = new Date().toISOString();
      await setAttribute(sub, "resetAt", now);
      console.log(`${sub}: ${now} から数え直します (アプリには 30 秒ほどで反映されます)`);
      return;
    }
    case "unreset":
      await removeAttribute(sub, "resetAt");
      console.log(`${sub}: 手動リセットを取り消しました (月初から数えます)`);
      return;
    default:
      usage();
  }
}

await main();
