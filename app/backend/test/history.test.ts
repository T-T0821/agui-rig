import assert from "node:assert/strict";
import { test } from "node:test";
import { handler, parseSaveBody } from "../src/history.ts";
import { periodStarts } from "../src/usage.ts";

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
