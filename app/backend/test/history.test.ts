import assert from "node:assert/strict";
import { test } from "node:test";
import { handler, parseSaveBody } from "../src/history.ts";
import { userNameOf } from "../src/http.ts";
import { evaluate, periodStartOf, periodStarts, resolveLimit } from "../src/usage.ts";

test("PUT の本文を確かめる", () => {
  assert.deepEqual(parseSaveBody(JSON.stringify({ title: "t", messagesGz: "H4sI" }), false), { title: "t", messagesGz: "H4sI" });
  assert.deepEqual(parseSaveBody(Buffer.from('{"title":"","messagesGz":"QQ=="}').toString("base64"), true), { title: "", messagesGz: "QQ==" });
  assert.equal(typeof parseSaveBody(undefined, false), "string");
  assert.equal(typeof parseSaveBody("{", false), "string");
  assert.equal(typeof parseSaveBody(JSON.stringify({ title: 1, messagesGz: "QQ==" }), false), "string");
  assert.equal(typeof parseSaveBody(JSON.stringify({ title: "t", messagesGz: "a b" }), false), "string");
  assert.equal(typeof parseSaveBody(JSON.stringify({ title: "t", messagesGz: "A".repeat(400_000) }), false), "string");
});

test("sub が無ければ 401、ID が不正なら 400", async () => {
  const base = { routeKey: "GET /threads/{id}", isBase64Encoded: false, requestContext: { authorizer: { jwt: { claims: {} } } } };
  assert.equal((await handler(base as never)).statusCode, 401);
  const withSub = { ...base, requestContext: { authorizer: { jwt: { claims: { sub: "auth0|1" } } } }, pathParameters: { id: "../x" } };
  assert.equal((await handler(withSub as never)).statusCode, 400);
});

test("今日と今月の始まり (JST)", () => {
  const { todayStart, monthStart } = periodStarts(new Date("2026-11-30T16:00:00Z"), 540);
  assert.equal(todayStart.toISOString(), "2026-11-30T15:00:00.000Z");
  assert.equal(monthStart.toISOString(), "2026-11-30T15:00:00.000Z");
});

test("利用上限の金額: 利用者の設定 → 既定値、0 は上限なし", () => {
  assert.equal(resolveLimit({}, 0), null);
  assert.equal(resolveLimit({}, 20), 20);
  assert.equal(resolveLimit({ monthlyLimitUsd: 5 }, 20), 5);
  assert.equal(resolveLimit({ monthlyLimitUsd: 0 }, 20), null);
  assert.equal(resolveLimit({}, Number.NaN), null);
});

test("上限の集計の始まり: 今月の手動リセットだけを使う", () => {
  const monthStart = new Date("2026-10-31T15:00:00Z");
  const now = new Date("2026-11-20T00:00:00Z");
  assert.equal(periodStartOf(monthStart, now, undefined), monthStart);
  assert.equal(periodStartOf(monthStart, now, "2026-11-10T00:00:00.000Z").toISOString(), "2026-11-10T00:00:00.000Z");
  assert.equal(periodStartOf(monthStart, now, "2026-10-20T00:00:00Z"), monthStart); // 先月のリセットは無視 (月初で自動で戻る)
  assert.equal(periodStartOf(monthStart, now, "2026-12-01T00:00:00Z"), monthStart); // 未来
  assert.equal(periodStartOf(monthStart, now, "not a date"), monthStart);
});

test("上限との比較", () => {
  assert.deepEqual(evaluate(100, null, 0.8), { warn: false, blocked: false });
  assert.deepEqual(evaluate(7, 10, 0.8), { warn: false, blocked: false });
  assert.deepEqual(evaluate(8, 10, 0.8), { warn: true, blocked: false });
  assert.deepEqual(evaluate(10, 10, 0.8), { warn: true, blocked: true });
});

test("利用者名は検証済みのクレームから", () => {
  const ev = (claims: Record<string, unknown>) => ({ requestContext: { authorizer: { jwt: { claims } } } }) as never;
  assert.equal(userNameOf(ev({ sub: "a", name: "山田 太郎", email: "t@example.com" })), "山田 太郎");
  assert.equal(userNameOf(ev({ sub: "a", "cognito:username": "taro" })), "taro");
  assert.equal(userNameOf(ev({ sub: "a", email: "t@example.com" })), "t@example.com");
  assert.equal(userNameOf(ev({ sub: "a", name: "  " })), undefined);
});
