import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";
export function request(ctx) {
  return ddb.get({ key: { pk: ctx.identity.sub, sk: ctx.args.id } });
}
export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type);
  const i = ctx.result;
  return i ? { id: i.sk, title: i.title, updatedAt: i.updatedAt, messagesGz: i.messagesGz } : null;
}
