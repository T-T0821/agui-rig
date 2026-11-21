// API Gateway (HTTP API、ペイロード 2.0) 用の共通部分。
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
export type Result = APIGatewayProxyStructuredResultV2;

/** JWT オーソライザーが検証した ID トークンの sub。利用者を分けるのはこれだけ (リクエストの中身は信用しない) */
export function subOf(event: Event): string | undefined {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  return typeof sub === "string" && sub !== "" ? sub : undefined;
}

/** 検証済みの ID トークンにある利用者名 (表示用)。Auth0 は name / nickname、Cognito は cognito:username。無ければメール */
export function userNameOf(event: Event): string | undefined {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  for (const key of ["name", "nickname", "cognito:username", "preferred_username", "email"]) {
    const v = claims[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim().slice(0, 200);
  }
  return undefined;
}

export function json(statusCode: number, body: unknown): Result {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export const noContent = (): Result => ({ statusCode: 204 });
export const error = (statusCode: number, message: string): Result => json(statusCode, { message });
