// API Gateway (REST API、Lambda プロキシ統合) 用の共通部分。
// 認証は REST API の Lambda オーソライザー (authorizer.ts) が ID トークンを検証し、
// 検証済みの sub と利用者名を requestContext.authorizer に入れて渡す。
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

export type Event = APIGatewayProxyEvent;
export type Result = APIGatewayProxyResult;

/** オーソライザーが Lambda に渡す値 (authorizer.ts の context と同じ名前) */
type AuthorizerContext = { sub?: unknown; userName?: unknown };

function authorizerOf(event: Pick<Event, "requestContext">): AuthorizerContext {
  return (event.requestContext?.authorizer ?? {}) as AuthorizerContext;
}

/**
 * オーソライザーが検証した ID トークンの sub。利用者を分けるのはこれだけ (リクエストの中身は信用しない)。
 * オーソライザーは署名・iss・aud・exp と、Cognito の token_use (id だけを認める) を確かめている。
 */
export function subOf(event: Pick<Event, "requestContext">): string | undefined {
  const sub = authorizerOf(event).sub;
  return typeof sub === "string" && sub !== "" ? sub : undefined;
}

/** 検証済みの ID トークンにある利用者名 (表示用)。オーソライザーが name / nickname / cognito:username / email から選ぶ */
export function userNameOf(event: Pick<Event, "requestContext">): string | undefined {
  const v = authorizerOf(event).userName;
  return typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 200) : undefined;
}

/** ルート ("GET /threads/{id}" の形)。REST API のリソースのパスとメソッドから作る */
export function routeOf(event: Pick<Event, "httpMethod" | "resource">): string {
  return `${event.httpMethod} ${event.resource}`;
}

export function json(statusCode: number, body: unknown): Result {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export const noContent = (): Result => ({ statusCode: 204, body: "" });
export const error = (statusCode: number, message: string): Result => json(statusCode, { message });
