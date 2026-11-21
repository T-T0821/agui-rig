// 開発者ごとの開発環境 (AWS 上の自分専用のバックエンド) を作る・消す。ルート (リポジトリの一番上) で実行する。
//   pnpm dev-env up      [--user <名前>] [--email <メール>] [--region <リージョン>] [-- <terraform apply の引数>]
//   pnpm dev-env down    [--user <名前>] [-- <terraform destroy の引数>]
//   pnpm dev-env status  [--user <名前>]
//   pnpm dev-env list
// infra/terraform を Terraform workspace `dev-<名前>` で、名前の接頭辞 `agui-rig-dev-<名前>` で apply する。
// Cognito のユーザープール・IAM ロール・API Gateway・Lambda・DynamoDB はすべて開発者ごとに別。
// up の後は `pnpm dev:cloud` で、本物のログイン (Cognito) つきでこの環境に向けてアプリを起動する。
// 自分の設定はリポジトリのルートの .env.cloud (例は .env.cloud.example) に書く: DEV_ENV_USER、DEV_ENV_EMAIL、AWS_PROFILE、AWS_REGION。
// up はできた環境の接続先 (OAUTH_ISSUER など) を同じファイルに書き足し、down で消す。`pnpm dev:cloud` はこのファイルを読む。
// 必要なもの: terraform (1.6 以上)、aws CLI、AWS の認証 (AWS_PROFILE / aws sso login など。IAM・Cognito・Lambda などを作れる権限)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUD_ENV_FILE, MANAGED_KEYS, loadCloudEnv, readCloudEnv, updateCloudEnv } from "./env-file.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "..", "..");
const tfDir = join(repo, "infra", "terraform");
const backendDir = join(repo, "app", "backend");
// .env.cloud の値 (AWS_PROFILE など) を、terraform と aws CLI にも渡るよう process.env に入れる
loadCloudEnv();
const isWindows = process.platform === "win32";

/** 引数を `--key value` と、`--` の後ろ (Terraform にそのまま渡す) に分ける。 */
function parseArgs(argv) {
  const opts = {};
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.includes("=") ? a.slice(2).split(/=(.*)/s) : [a.slice(2), argv[++i]];
      if (v === undefined) fail(`--${k} に値がありません`);
      opts[k] = v;
    } else {
      fail(`知らない引数です: ${a}`);
    }
  }
  return { opts, passthrough };
}

function fail(message) {
  console.error(`[dev-env] ${message}`);
  process.exit(1);
}

function run(cmd, args, { cwd = tfDir, capture = false, allowFail = false, shell = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit", encoding: "utf8", shell });
  if (r.error) fail(`${cmd} を実行できません (${r.error.code === "ENOENT" ? "インストールされていません" : r.error.message})`);
  if (r.status !== 0 && !allowFail) {
    if (capture) process.stderr.write(r.stderr ?? "");
    fail(`${cmd} ${args.join(" ")} が失敗しました (終了コード ${r.status})`);
  }
  return r;
}

const terraform = (args, options) => run("terraform", args, options);

function git(args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

/**
 * 開発者の名前。リソース名・Cognito のドメインに入るので英小文字・数字・ハイフンで 20 文字まで。
 * --user > DEV_ENV_USER > OS のユーザ名。
 */
function resolveUser(opts) {
  const raw = opts.user || process.env.DEV_ENV_USER || userInfo().username;
  const user = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, "");
  if (!user) fail("ユーザ名を決められません。--user <名前> か DEV_ENV_USER を指定してください");
  if (opts.user && user !== opts.user) fail(`--user は英小文字・数字・ハイフンで 20 文字までにしてください (例: ${user})`);
  return user;
}

const workspaceOf = (user) => `dev-${user}`;
const nameOf = (user) => `agui-rig-dev-${user}`;

/** 開発者ごとの環境の Terraform 変数。up と down (destroy にも変数の検証が要る) で同じ値を渡す。 */
function stackVars(user, region) {
  const name = nameOf(user);
  return [
    `-var=region=${region}`,
    `-var=name=${name}`,
    `-var=table_name=${name}-chat-history`,
    "-var=create_cognito=true",
    "-var=environment=dev",
    `-var=owner=${user}`,
    // 使い捨てなので PITR は切る。利用料金 (Langfuse・VPC が要る) は作らない
    "-var=point_in_time_recovery=false",
  ];
}

function ensureInit() {
  if (!existsSync(join(tfDir, ".terraform"))) terraform(["init", "-input=false"]);
}

function currentWorkspace() {
  return terraform(["workspace", "show"], { capture: true }).stdout.trim();
}

function workspaces() {
  return terraform(["workspace", "list"], { capture: true })
    .stdout.split("\n")
    .map((l) => l.replace(/^\*/, "").trim())
    .filter(Boolean);
}

function outputs() {
  const r = terraform(["output", "-json"], { capture: true, allowFail: true });
  if (r.status !== 0) return {};
  return Object.fromEntries(Object.entries(JSON.parse(r.stdout || "{}")).map(([k, v]) => [k, v.value]));
}

/** Lambda の zip の元 (app/backend/dist) が無ければビルドする。 */
function ensureBackendBuilt() {
  if (existsSync(join(backendDir, "dist", "history.mjs"))) return;
  console.error("[dev-env] バックエンドの Lambda をビルドします…");
  if (!existsSync(join(backendDir, "node_modules"))) run("pnpm", ["install", "--frozen-lockfile"], { cwd: repo, shell: isWindows });
  run("pnpm", ["run", "build"], { cwd: backendDir, shell: isWindows });
}

/** 自分のメールアドレスで Cognito の利用者を作る (既にあれば何もしない)。仮パスワードはメールで届く。 */
function ensureCognitoUser(poolId, email, region) {
  const got = run("aws", ["cognito-idp", "admin-get-user", "--region", region, "--user-pool-id", poolId, "--username", email], {
    capture: true,
    allowFail: true,
  });
  if (got.status === 0) {
    console.error(`[dev-env] Cognito の利用者 ${email} は作成済みです`);
    return;
  }
  if (!/UserNotFoundException/.test(got.stderr ?? "")) {
    process.stderr.write(got.stderr ?? "");
    fail("Cognito の利用者を確認できませんでした");
  }
  run("aws", [
    "cognito-idp",
    "admin-create-user",
    "--region",
    region,
    "--user-pool-id",
    poolId,
    "--username",
    email,
    "--user-attributes",
    `Name=email,Value=${email}`,
    "Name=email_verified,Value=true",
    "--desired-delivery-mediums",
    "EMAIL",
  ], { capture: true });
  console.error(`[dev-env] Cognito の利用者 ${email} を作りました。仮パスワードがメールで届きます (初回ログインで変更)`);
}

/** 接続先を .env.cloud に書く。名前とメールは、ファイルに無ければ次回のために書いておく。 */
function writeCloudEnv(user, email, out) {
  const current = readCloudEnv();
  updateCloudEnv(
    {
      ...(current.DEV_ENV_USER ? {} : { DEV_ENV_USER: user }),
      ...(current.DEV_ENV_EMAIL || !email ? {} : { DEV_ENV_EMAIL: email }),
      ...(current.AWS_REGION ? {} : { AWS_REGION: out.region }),
    },
    { managed: false },
  );
  const values = {
    OAUTH_ISSUER: out.oauth_issuer,
    OAUTH_CLIENT_ID: out.oauth_client_id,
    OAUTH_REDIRECT_PORT: "53682",
    AWS_ROLE_ARN: out.app_role_arn,
    CHAT_API_URL: out.chat_api_url,
  };
  updateCloudEnv(values);
  return values;
}

/** workspace を選ぶ。ほかの開発者の環境を誤って触らないよう、選んだ後に確かめる。 */
function selectWorkspace(ws, { create }) {
  ensureInit();
  if (create) {
    terraform(["workspace", "select", "-or-create", ws]);
  } else {
    if (!workspaces().includes(ws)) fail(`workspace ${ws} がありません (pnpm dev-env list で確認)`);
    terraform(["workspace", "select", ws]);
  }
  if (currentWorkspace() !== ws) fail(`workspace を ${ws} に切り替えられませんでした`);
}

const [command, ...rest] = process.argv.slice(2);
const { opts, passthrough } = parseArgs(rest);

switch (command) {
  case "up": {
    const user = resolveUser(opts);
    const ws = workspaceOf(user);
    const name = nameOf(user);
    const region = opts.region || process.env.AWS_REGION || "ap-northeast-1";
    const email = opts.email || process.env.DEV_ENV_EMAIL || git(["config", "user.email"]);
    if (!email || !email.includes("@")) fail("ログインに使うメールアドレスを --email か DEV_ENV_EMAIL で指定してください");

    ensureBackendBuilt();
    selectWorkspace(ws, { create: true });
    terraform([
      "apply",
      "-input=false",
      ...stackVars(user, region),
      ...passthrough,
    ]);
    const out = outputs();
    if (!out.cognito_user_pool_id) fail("Cognito のユーザープールが出力にありません");
    ensureCognitoUser(out.cognito_user_pool_id, email, out.region);
    writeCloudEnv(user, email, out);
    console.error(`
[dev-env] ${user} の開発環境ができました (workspace ${ws}, 接頭辞 ${name})
  接続先: ${CLOUD_ENV_FILE}
  起動:   pnpm dev:cloud   (${email} でログイン)
  削除:   pnpm dev-env down`);
    break;
  }

  case "down": {
    const user = resolveUser(opts);
    const ws = workspaceOf(user);
    selectWorkspace(ws, { create: false });
    // destroy でも Lambda の zip (data.archive_file) が要る
    ensureBackendBuilt();
    const before = outputs();
    const region = opts.region || before.region || process.env.AWS_REGION || "ap-northeast-1";
    terraform([
      "destroy",
      "-input=false",
      ...stackVars(user, region),
      ...passthrough,
    ]);
    const left = terraform(["state", "list"], { capture: true, allowFail: true }).stdout.trim();
    if (left) fail(`まだリソースが残っています。workspace ${ws} はそのままにします:\n${left}`);
    terraform(["workspace", "select", "default"]);
    terraform(["workspace", "delete", ws]);
    // .env.cloud がこの環境を指していれば接続先だけ消す (自分で書いた値は残す)
    if (before.chat_api_url && readCloudEnv().CHAT_API_URL === before.chat_api_url) {
      updateCloudEnv(Object.fromEntries(MANAGED_KEYS.map((k) => [k, undefined])));
    }
    console.error(`[dev-env] ${user} の開発環境を削除しました`);
    break;
  }

  case "status": {
    const user = resolveUser(opts);
    selectWorkspace(workspaceOf(user), { create: false });
    const out = outputs();
    if (!out.chat_api_url) fail(`${user} の開発環境はまだ作られていません (pnpm dev-env up)`);
    const values = writeCloudEnv(user, "", out);
    for (const k of MANAGED_KEYS) console.log(`${k}=${values[k]}`);
    break;
  }

  case "list": {
    ensureInit();
    const devs = workspaces().filter((w) => w.startsWith("dev-"));
    console.log(devs.length ? devs.join("\n") : "(この state には開発者ごとの環境がありません)");
    break;
  }

  default:
    console.error("使い方: pnpm dev-env up | down | status | list  [--user <名前>] [--email <メール>] [--region <リージョン>]");
    process.exit(1);
}
