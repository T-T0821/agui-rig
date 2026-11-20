// API Gateway (HTTP API、ペイロード 2.0) 用の共通部分。
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
export type Result = APIGatewayProxyStructuredResultV2;

/** JWT オーソライザーが検証した ID トークンの sub。利用者を分けるのはこれだけ (リクエストの中身は信用しない) */
export function subOf(event: Event): string | undefined {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  return typeof sub === "string" && sub !== "" ? sub : undefined;
}

export function json(statusCode: number, body: unknown): Result {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export const noContent = (): Result => ({ statusCode: 204 });
export const error = (statusCode: number, message: string): Result => json(statusCode, { message });
