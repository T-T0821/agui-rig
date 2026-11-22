import assert from "node:assert/strict";
import { test } from "node:test";
import { handler, parseSaveBody } from "../src/history.ts";
import { subOf, userNameOf } from "../src/http.ts";
import { evaluate, ledgerKeys, periodStartOf, periodStarts, resolveLimit, summarize } from "../src/ledger.ts";

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
  const base = { httpMethod: "GET", resource: "/threads/{id}", isBase64Encoded: false, requestContext: { authorizer: {} } };
  assert.equal((await handler(base as never)).statusCode, 401);
  const withSub = { ...base, requestContext: { authorizer: { sub: "auth0|1" } }, pathParameters: { id: "../x" } };
  assert.equal((await handler(withSub as never)).statusCode, 400);
});

test("sub はオーソライザーが渡した値だけを使う", () => {
  const ev = (authorizer: Record<string, unknown>) => ({ requestContext: { authorizer } }) as never;
  assert.equal(subOf(ev({ sub: "auth0|1", principalId: "auth0|1" })), "auth0|1");
  assert.equal(subOf(ev({ sub: "" })), undefined);
  assert.equal(subOf(ev({ principalId: "x" })), undefined);
  assert.equal(subOf({ requestContext: {} } as never), undefined);
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

test("利用者名はオーソライザーが渡した値から", () => {
  const ev = (authorizer: Record<string, unknown>) => ({ requestContext: { authorizer } }) as never;
  assert.equal(userNameOf(ev({ sub: "a", userName: "山田 太郎" })), "山田 太郎");
  assert.equal(userNameOf(ev({ sub: "a", userName: "  " })), undefined);
  assert.equal(userNameOf(ev({ sub: "a" })), undefined);
});

test("台帳のキーは日本時間の月と日", () => {
  assert.deepEqual(ledgerKeys(new Date("2026-11-30T15:30:00Z"), 540), { month: "M#2026-12", day: "D#2026-12-01" });
  assert.deepEqual(ledgerKeys(new Date("2026-11-30T14:59:00Z"), 540), { month: "M#2026-11", day: "D#2026-11-30" });
});

test("台帳の金額から /usage の応答を作る (手動リセット後はリセット時点の金額を引く)", () => {
  const now = new Date("2026-11-20T00:00:00Z");
  const opts = { offset: 540, defaultLimitUsd: 10, warnRatio: 0.8 };
  const plain = summarize(now, { todayUsd: 1, monthUsd: 9 }, {}, opts);
  assert.equal(plain.monthStart, "2026-10-31T15:00:00.000Z");
  assert.deepEqual([plain.periodUsd, plain.limitUsd, plain.warn, plain.blocked], [9, 10, true, false]);
  const blocked = summarize(now, { todayUsd: 1, monthUsd: 12 }, {}, opts);
  assert.equal(blocked.blocked, true);
  const reset = summarize(now, { todayUsd: 1, monthUsd: 12 }, { resetAt: "2026-11-10T00:00:00.000Z", resetBaseUsd: 11 }, opts);
  assert.deepEqual([reset.periodStart, reset.periodUsd, reset.blocked], ["2026-11-10T00:00:00.000Z", 1, false]);
  // 先月のリセットは無視する (月初で自動で戻る)
  const old = summarize(now, { todayUsd: 1, monthUsd: 3 }, { resetAt: "2026-10-10T00:00:00.000Z", resetBaseUsd: 50 }, opts);
  assert.equal(old.periodUsd, 3);
});
