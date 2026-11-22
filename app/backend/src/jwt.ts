// ID トークン (OpenID Connect の JWT) の検証。Auth0 でも Cognito でも同じコードで動く (IdP に依存しない)。
//   - 署名: issuer の discovery (/.well-known/openid-configuration) の jwks_uri の鍵で確かめる (鍵はキャッシュする)
//   - iss: OIDC_ISSUER と完全一致 (Auth0 は末尾に / が付く)
//   - aud: OIDC_CLIENT_ID (ID トークンの aud は Client ID)
//   - exp / nbf: jose が確かめる (時計のずれは 30 秒まで許す)
//   - token_use: Cognito 独自のクレーム。あれば "id" だけを認める (Cognito のアクセストークンも aud ではなく client_id を持つが、念のため)
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from "jose";

export type VerifiedClaims = JWTPayload & { sub: string };

type KeySet = ReturnType<typeof createRemoteJWKSet>;
let cached: { issuer: string; keys: KeySet } | undefined;

/** issuer の JWKS。discovery で jwks_uri を引く (Auth0・Cognito とも discovery に対応している) */
async function keysFor(issuer: string): Promise<KeySet> {
  if (cached?.issuer === issuer) return cached.keys;
  const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC の discovery を読めません: ${res.status}`);
  const { jwks_uri } = (await res.json()) as { jwks_uri?: string };
  if (!jwks_uri?.startsWith("https://")) throw new Error("discovery に https の jwks_uri がありません");
  const keys = createRemoteJWKSet(new URL(jwks_uri), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  cached = { issuer, keys };
  return keys;
}

/** `Authorization` ヘッダーの値から Bearer トークンを取り出す */
export function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header?.trim() ?? "");
  return m?.[1];
}

/**
 * ID トークンを検証して、クレームを返す。不正なら例外。
 * `keys` はテスト用 (省略時は issuer の discovery から引く)。
 */
export async function verifyIdToken(
  token: string,
  opts: { issuer: string; audience: string; keys?: Parameters<typeof jwtVerify>[1] },
): Promise<VerifiedClaims> {
  const keys = opts.keys ?? (await keysFor(opts.issuer));
  const { payload } = await jwtVerify(token, keys as KeySet, {
    issuer: opts.issuer,
    audience: opts.audience,
    algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "PS256"],
    clockTolerance: 30,
    requiredClaims: ["sub", "exp"],
  });
  if (payload.token_use !== undefined && payload.token_use !== "id") throw new Error("ID トークンではありません");
  if (typeof payload.sub !== "string" || payload.sub === "") throw new Error("sub がありません");
  return payload as VerifiedClaims;
}

/** 表示用の利用者名。Auth0 は name / nickname、Cognito は cognito:username。無ければメール */
export function userNameOfClaims(claims: JWTPayload): string | undefined {
  for (const key of ["name", "nickname", "cognito:username", "preferred_username", "email"]) {
    const v = claims[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim().slice(0, 200);
  }
  return undefined;
}
