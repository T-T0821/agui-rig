# agui-rig

React + CopilotKit のチャット UI を Tauri 2 のデスクトップアプリ (Windows / macOS / Linux) に載せ、エージェントを Rust の Rig で動かすアプリです。

- **モデル**: Amazon Bedrock (Rig の `rig-bedrock`)
- **認証**: 共通基盤の OAuth (OpenID Connect) でログインし、ID トークンを STS `AssumeRoleWithWebIdentity` で一時 IAM 認証情報に交換。長期のアクセスキーは使わない
- **ツール**: Amazon Bedrock AgentCore Code Interpreter と、PC 上で起動する stdio MCP サーバー
- **画面との接続**: AG-UI プロトコル。フロントは `@ag-ui/client` の `HttpAgent` で Rust の AG-UI エンドポイントに直接つなぐ (CopilotKit の Node ランタイムは使わない)

## 構成

```
┌───────────────────────── Tauri アプリ (1 プロセス) ─────────────────────────┐
│ WebView (React)                    Rust                                     │
│  CopilotChat ─ HttpAgent ─ POST /agent ─▶ axum (127.0.0.1) ─ AG-UI / SSE    │
│  ログイン画面 ─ invoke("login") ────────▶ OAuth (PKCE) ── ブラウザでログイン │
│                                           │ ID トークン                      │
│                                           ▼                                 │
│                                  STS AssumeRoleWithWebIdentity              │
│                                           │ 一時 IAM 認証情報                │
│                       Rig のツールループ ─┼─▶ Bedrock (ConverseStream)      │
│                                           ├─▶ AgentCore Code Interpreter    │
│                                           └─▶ stdio MCP サーバー (子プロセス)│
└─────────────────────────────────────────────────────────────────────────────┘
```

1. 「ログイン」で OS の既定ブラウザが開き、共通基盤でログインする。リダイレクトは `http://127.0.0.1:<port>/callback` で受ける (RFC 8252、クライアントシークレットなし)。
2. Rust が ID トークンを STS に渡して一時認証情報を得る。期限前に SDK が自動で取り直し、ID トークンもリフレッシュトークンで自動更新する。**トークンと認証情報は Rust のメモリ上だけに置き、WebView には渡さない。**
3. チャットを送ると、Rig がモデルを呼び、モデルがツールを呼べば実行して結果を返す、をツールを呼ばなくなるまで繰り返す (最大 10 回)。その様子は AG-UI のイベント (`TEXT_MESSAGE_*`、`TOOL_CALL_START / ARGS / END / RESULT`) で画面に流れ、ツール呼び出しはカードで表示される。

### ツール

| ツール名 (モデルから見える名前) | 内容 |
| --- | --- |
| `code_interpreter_execute_code` | AgentCore Code Interpreter でコードを実行 (Python / JavaScript / TypeScript) |
| `code_interpreter_execute_command` | 同じサンドボックスでシェルコマンドを実行 |
| `<サーバー名>__<ツール名>` | mcp.json に書いた stdio MCP サーバーのツール |

- Code Interpreter のセッションはチャットのスレッドごとに 1 つ作るので、同じスレッドでは変数やファイルが引き継がれる。ログアウトやアプリ終了で止める。
- MCP サーバーはアプリ起動時に子プロセスとして起動し、終了時に止める。**AWS の認証情報などを渡さないよう、環境変数は `PATH` など最小限だけ引き継ぐ** (必要なものは mcp.json の `env` に書く)。Windows では `npx` などのバッチファイルも動くよう `cmd /C` 経由で、コンソールウィンドウを出さずに起動する。

## AWS 側の準備

1. **IAM の OIDC プロバイダー**: 共通基盤の issuer URL を登録し、audience に OAuth のクライアント ID を入れる。issuer は HTTPS で公開されていて、AWS から JWKS を取得できる必要がある。
2. **IAM ロール**: 信頼ポリシーで、そのプロバイダーからの `sts:AssumeRoleWithWebIdentity` を許可する (`<issuer>:aud` をクライアント ID で条件付け)。権限は必要なものだけにする。例:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModel"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:StartCodeInterpreterSession",
        "bedrock-agentcore:InvokeCodeInterpreter",
        "bedrock-agentcore:StopCodeInterpreterSession"
      ],
      "Resource": "*"
    }
  ]
}
```

`Resource` は、使うモデル (推論プロファイル) と Code Interpreter の ARN に絞るのがおすすめです。CloudTrail には、ロールセッション名として `chat-<email または sub>` が残ります。

## 動かし方

必要なもの: Node.js 20 以上、Rust 1.97.1 以上、[Tauri の前提パッケージ](https://v2.tauri.app/start/prerequisites/) (Windows は WebView2 と MSVC ビルドツール)。

```sh
npm install
cp .env.example .env            # OAuth / AWS / モデルの設定
cp mcp.example.json mcp.json    # 使う MCP サーバー (例は examples/time-mcp)
(cd examples/time-mcp && npm install)
MCP_CONFIG=./mcp.json npm run tauri dev
```

設定は `.env.example` を参照してください。主なもの:

| 変数 | 内容 |
| --- | --- |
| `OAUTH_ISSUER` / `OAUTH_CLIENT_ID` | 共通基盤の OIDC。未設定ならログインなしの開発モード (AWS は `AWS_PROFILE` や SSO など SDK 標準の認証) |
| `AWS_REGION` / `AWS_ROLE_ARN` | リージョンと、ID トークンで引き受けるロール |
| `BEDROCK_MODEL_ID` | Bedrock のモデル (既定 `global.anthropic.claude-sonnet-5-5`) |
| `CODE_INTERPRETER_ID` | 既定は AWS マネージドの `aws.codeinterpreter.v1`。`off` で無効 |
| `MCP_CONFIG` | mcp.json の場所。未設定ならアプリの設定フォルダの `mcp.json` |

### Anthropic API で動作確認する

Bedrock の準備前に本物のモデルで試したい場合は、`.env` に次を書きます (`.env` はコミットされません)。

```sh
LLM_MODEL=anthropic/claude-sonnet-5-5
ANTHROPIC_API_KEY=...
```

このとき OAuth を設定していなければ、Code Interpreter は無効になります (AWS の認証が無いため)。AWS の認証があるなら `CODE_INTERPRETER_ID=aws.codeinterpreter.v1` で有効にできます。

### 疑似サーバーでの確認

AWS 側のエンドポイントは、AWS SDK 標準の環境変数 `AWS_ENDPOINT_URL_STS` / `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` / `AWS_ENDPOINT_URL_BEDROCK_AGENTCORE` で差し替えられます (VPC エンドポイントにも使えます)。

## ファイル

| パス | 内容 |
| --- | --- |
| `src/App.tsx` | ログイン画面、CopilotKit (v2) と HttpAgent |
| `src/ToolCallCard.tsx` | ツール呼び出しのカード表示 |
| `src-tauri/src/lib.rs` | 起動、ログイン / ログアウト、実行環境の組み立て |
| `src-tauri/src/auth.rs` | OAuth (Authorization Code + PKCE、ループバック、リフレッシュ) |
| `src-tauri/src/aws.rs` | STS AssumeRoleWithWebIdentity の credential provider |
| `src-tauri/src/agent.rs` | Rig のツールループと AG-UI イベントへの変換 |
| `src-tauri/src/tools/` | Code Interpreter と stdio MCP |
| `src-tauri/src/server.rs` | AG-UI エンドポイント (`POST /agent`、SSE) |
| `examples/time-mcp/` | 動作確認用の stdio MCP サーバー |

## 補足

- CopilotKit の表示では、`selfManagedAgents` は Enterprise tier の機能とされています。キーなしでも動作しますが、配布前にライセンス条件を確認してください。
- 過去のターンのツール呼び出しと結果は、次のターンではテキストとしてモデルに渡しています (プロバイダーのツール ID の整合を気にしなくて済むように)。
