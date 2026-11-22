// REST API の Lambda オーソライザー (TOKEN 型)。全ルート (/threads、/usage、/v1/...) で共用する。
// ID トークン (Auth0 / Cognito) を jwt.ts で検証し、通れば API 全体の呼び出しを許す方針と、
// 検証済みの sub・利用者名を返す。各 Lambda は requestContext.authorizer.sub だけで利用者を分ける。
// 結果は API Gateway がトークンごとにキャッシュする (Terraform の authorizer_cache_ttl 秒)。
import type { APIGatewayAuthorizerResult, APIGatewayTokenAuthorizerEvent } from "aws-lambda";
import { bearerToken, userNameOfClaims, verifyIdToken } from "./jwt.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} がありません`);
  return v;
}

/**
 * 許す範囲: 同じ API・同じステージの全メソッド。キャッシュした結果をほかのルートでも使えるように、
 * 呼ばれたメソッドだけでなくステージ全体にする (どのルートも同じ ID トークンで認証するため)。
 */
export function stageWildcard(methodArn: string): string {
  // arn:aws:execute-api:<region>:<account>:<apiId>/<stage>/<METHOD>/<path...>
  const [prefix, stage] = methodArn.split("/");
  return `${prefix}/${stage}/*/*`;
}

export async function handler(event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  const token = bearerToken(event.authorizationToken);
  if (!token) throw new Error("Unauthorized");
  let claims;
  try {
    claims = await verifyIdToken(token, { issuer: env("OIDC_ISSUER"), audience: env("OIDC_CLIENT_ID") });
  } catch (e) {
    console.warn("ID トークンを認めません", e instanceof Error ? e.message : e);
    // この文字列のときだけ API Gateway は 401 を返す (ほかは 500)
    throw new Error("Unauthorized");
  }
  const userName = userNameOfClaims(claims);
  return {
    principalId: claims.sub,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: stageWildcard(event.methodArn) }],
    },
    context: { sub: claims.sub, ...(userName ? { userName } : {}) },
  };
}
