// チャット履歴: API Gateway (JWT オーソライザー) → この Lambda → DynamoDB
//   GET    /threads        自分の会話の一覧
//   GET    /threads/{id}   会話 1 件 (無ければ 404)
//   PUT    /threads/{id}   保存 (上書き) { title, messagesGz }
//   DELETE /threads/{id}   削除
// pk はオーソライザーが検証した sub だけ。他人の会話を指定する方法は無い。
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Event, type Result, error, json, noContent, subOf } from "./http.ts";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = () => process.env.TABLE_NAME ?? "";

/** 会話 ID は UUID などの短い文字列だけ */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TITLE = 200;
/** DynamoDB の項目の上限 400KB に、ほかの属性の分の余裕を残す */
const MAX_MESSAGES_GZ = 380_000;

export type SaveBody = { title: string; messagesGz: string };

/** PUT の本文を確かめる。おかしければエラーの文言を返す */
export function parseSaveBody(body: string | undefined, isBase64Encoded: boolean): SaveBody | string {
  if (!body) return "本文がありません";
  let value: unknown;
  try {
    value = JSON.parse(isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body);
  } catch {
    return "本文が JSON ではありません";
  }
  const { title, messagesGz } = (value ?? {}) as Record<string, unknown>;
  if (typeof title !== "string" || title.length > MAX_TITLE) return `title は ${MAX_TITLE} 文字以内の文字列にしてください`;
  if (typeof messagesGz !== "string" || messagesGz === "" || messagesGz.length > MAX_MESSAGES_GZ)
    return `messagesGz は ${MAX_MESSAGES_GZ} バイト以内の文字列にしてください`;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(messagesGz)) return "messagesGz は base64 にしてください";
  return { title, messagesGz };
}

export async function handler(event: Event): Promise<Result> {
  const sub = subOf(event);
  if (!sub) return error(401, "Unauthorized");
  const id = event.pathParameters?.id;
  if (id !== undefined && !ID_PATTERN.test(id)) return error(400, "会話 ID が不正です");

  switch (event.routeKey) {
    case "GET /threads": {
      const out = await db.send(
        new QueryCommand({
          TableName: table(),
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": sub },
          ProjectionExpression: "sk, title, updatedAt",
          ScanIndexForward: false,
          Limit: 200,
        }),
      );
      return json(200, (out.Items ?? []).map((i) => ({ id: i.sk, title: i.title, updatedAt: i.updatedAt })));
    }
    case "GET /threads/{id}": {
      const out = await db.send(new GetCommand({ TableName: table(), Key: { pk: sub, sk: id } }));
      const i = out.Item;
      if (!i) return error(404, "会話がありません");
      return json(200, { id: i.sk, title: i.title, updatedAt: i.updatedAt, messagesGz: i.messagesGz });
    }
    case "PUT /threads/{id}": {
      const body = parseSaveBody(event.body, event.isBase64Encoded);
      if (typeof body === "string") return error(400, body);
      const now = new Date().toISOString();
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { pk: sub, sk: id },
          // title は DynamoDB の予約語ではないが、念のため名前は置き換えて書く
          UpdateExpression: "SET #t = :t, #m = :m, #u = :now, #c = if_not_exists(#c, :now)",
          ExpressionAttributeNames: { "#t": "title", "#m": "messagesGz", "#u": "updatedAt", "#c": "createdAt" },
          ExpressionAttributeValues: { ":t": body.title, ":m": body.messagesGz, ":now": now },
        }),
      );
      return json(200, { id, title: body.title, updatedAt: now });
    }
    case "DELETE /threads/{id}": {
      await db.send(new DeleteCommand({ TableName: table(), Key: { pk: sub, sk: id } }));
      return noContent();
    }
    default:
      return error(404, "Not Found");
  }
}
