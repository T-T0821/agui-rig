import { util } from "@aws-appsync/utils";
export function request(ctx) {
  const now = util.time.nowISO8601();
  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ pk: ctx.identity.sub, sk: ctx.args.id }),
    update: {
      expression: "SET title = :title, messagesGz = :m, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)",
      expressionValues: util.dynamodb.toMapValues({ ":title": ctx.args.title, ":m": ctx.args.messagesGz, ":now": now }),
    },
  };
}
export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type);
  const i = ctx.result;
  return { id: i.sk, title: i.title, updatedAt: i.updatedAt };
}
