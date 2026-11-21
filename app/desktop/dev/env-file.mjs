// 自分の AWS 開発環境の設定ファイル (リポジトリのルートの .env.cloud、git には入れない)。
// 自分で書く値 (DEV_ENV_USER、DEV_ENV_EMAIL、AWS_PROFILE、AWS_REGION など) と、
// `pnpm dev-env up` が書き込む接続先 (OAUTH_ISSUER など) を、どちらも KEY=VALUE で 1 つのファイルに持つ。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLOUD_ENV_FILE = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), ".env.cloud");

/** `pnpm dev-env up` が書き、`down` で消す接続先のキー。 */
export const MANAGED_KEYS = ["OAUTH_ISSUER", "OAUTH_CLIENT_ID", "OAUTH_REDIRECT_PORT", "AWS_ROLE_ARN", "CHAT_API_URL"];

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(v) {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1);
  return v.replace(/\s+#.*$/, "");
}

/** ファイルの KEY=VALUE を読む。無ければ空。 */
export function readCloudEnv(file = CLOUD_ENV_FILE) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = LINE.exec(line);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

/** ファイルの値を process.env に入れる。シェルで設定済みの値が優先 (アプリの .env と同じ)。 */
export function loadCloudEnv(file = CLOUD_ENV_FILE) {
  const env = readCloudEnv(file);
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
  return env;
}

const HEADER = "# ---- pnpm dev-env up が書く接続先 (手で変えない。down で消える) ----";

/**
 * キーを書き換える。既にある行はその場で値を替え、無いキーは足す。値が undefined のキーは行ごと消す。
 * ほかの行 (自分で書いた値やコメント) はそのまま残す。
 * managed = true なら新しいキーは末尾の「接続先」の見出しの下に、false なら見出しより上に足す。
 */
export function updateCloudEnv(values, { managed = true } = {}, file = CLOUD_ENV_FILE) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const rest = { ...values };
  const kept = [];
  for (const line of lines) {
    const m = /^\s*#/.test(line) ? null : LINE.exec(line);
    if (m && m[1] in rest) {
      if (rest[m[1]] !== undefined) kept.push(`${m[1]}=${rest[m[1]]}`);
      delete rest[m[1]];
    } else {
      kept.push(line);
    }
  }
  const added = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  let header = kept.indexOf(HEADER);
  if (added.length && managed) {
    if (header < 0) {
      if (kept.length && kept.at(-1) !== "") kept.push("");
      kept.push(HEADER);
    }
    kept.push(...added);
  } else if (added.length) {
    if (header < 0) kept.push(...added);
    else {
      // 見出しの前の空行より上に入れる
      while (header > 0 && kept[header - 1] === "") header--;
      kept.splice(header, 0, ...added);
    }
  }
  // 接続先が 1 つも残っていなければ見出しも消す
  header = kept.indexOf(HEADER);
  if (header >= 0 && !kept.slice(header + 1).some((l) => LINE.test(l) && !/^\s*#/.test(l))) {
    kept.splice(header);
    while (kept.length && kept.at(-1) === "") kept.pop();
  }
  writeFileSync(file, kept.length ? `${kept.join("\n")}\n` : "");
}
