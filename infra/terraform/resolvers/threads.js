import { util } from "@aws-appsync/utils";
export function request(ctx) {
  return {
    operation: "Query",
    query: { expression: "pk = :pk", expressionValues: { ":pk": { S: ctx.identity.sub } } },
    projection: { expression: "sk, title, updatedAt" },
    scanIndexForward: false,
    limit: 200,
  };
}
export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type);
  // 並べ替え (新しい順) はアプリ側で行う
  return ctx.result.items.map((i) => ({ id: i.sk, title: i.title, updatedAt: i.updatedAt }));
}
