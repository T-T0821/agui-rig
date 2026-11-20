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
| `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | トレースを Langfuse に送る (下記) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` | Langfuse のキーの代わりに、任意の OTLP/HTTP 受け口 (Collector など) に送る |
| `TELEMETRY_RECORD_CONTENT` | `true` でプロンプト・回答・ツールの入出力・利用者 ID もトレースに含める (既定は含めない) |
| `RUST_LOG` | ログの詳しさ (既定 `info`) |

### トレース (Langfuse)

Rig はモデル呼び出しごとに OpenTelemetry の GenAI 規約に沿ったスパン (モデル名、トークン数など) を出します。
アプリはそれを OTLP/HTTP で Langfuse の `/api/public/otel/v1/traces` に送ります。

Langfuse での見え方:

- チャット 1 回 = トレース 1 本。名前は `chat`、セッション = AG-UI のスレッド ID
- その下に、モデル呼び出し (`chat`、Generation として表示) とツール呼び出し (`execute_tool <ツール名>`) が順に並ぶ
- 失敗した実行とツールは ERROR レベルになる

本文 (プロンプト、回答、ツールの入出力) と利用者 ID (STS のセッション名と同じメールなど) は、
`TELEMETRY_RECORD_CONTENT=true` のときだけ送ります。ID トークンや AWS の認証情報は送りません。

#### 料金の計測

モデル呼び出しのスパンには、トークン数を重ならない 4 つの区分に分けて載せています
(`langfuse.observation.usage_details`)。Langfuse はこれにモデル定義の単価を掛けて、
呼び出し・トレース・利用者・セッションごとの料金を出します。

| キー | 中身 |
| --- | --- |
| `input` | キャッシュを使わなかった入力トークン |
| `output` | 出力トークン |
| `cache_read_input_tokens` | キャッシュから読んだ入力トークン |
| `cache_creation_input_tokens` | キャッシュに書いた入力トークン |

Bedrock のモデル ID (`global.anthropic.claude-sonnet-5-5` など) は Langfuse 組み込みの単価表に
一致しないことがあるので、使うモデルごとにモデル定義を 1 件追加します。

1. Langfuse の **Project Settings → Models** で **Add model definition** を押す
   (トレース画面の Generation に出ているモデル名のバッジからも作れます)
2. **Model name**: 分かりやすい名前 (例 `bedrock-claude-sonnet-5-5`)
3. **Match pattern**: アプリが送るモデル ID に一致する正規表現。
   推論プロファイルの接頭辞 (`global.` / `us.` / `apac.` など) の有無を両方含めておくと安全です
   ```
   (?i)^(global\.|us\.|eu\.|apac\.|jp\.)?anthropic\.claude-sonnet-5-5.*$
   ```
4. **Prices**: 上の 4 つのキーそれぞれに、1 トークンあたりの USD 単価を入れる
   (Bedrock の料金ページの「100 万トークンあたり」の金額 ÷ 1,000,000)。
   キー名は上の表と完全に一致させてください。一致しないキーは料金 0 になります
5. 保存すると、それ以降に届いたトレースに料金が付きます (過去分には付きません)

注意:

- 単価はリージョンや推論プロファイル (グローバル / リージョン) で変わることがあります。使っているものの単価を入れてください
- Langfuse の料金は、利用者別・会話別の内訳を見るための推定値です。請求額は AWS の Cost Explorer が正です
- 利用者別に見るには `TELEMETRY_RECORD_CONTENT=true` が必要です (利用者 ID はこのときだけ送るため)

> **配布するときの注意**: Langfuse のシークレットキーはプロジェクトのデータを読み書きできるので、
> 利用者の PC に配るアプリへ直接入れるのは避けてください。本番では、キーを持った
> OpenTelemetry Collector (社内のゲートウェイ) を立てて、アプリは `OTEL_EXPORTER_OTLP_ENDPOINT` でそこに送る構成にします。
> `LANGFUSE_*` を直接使うのは開発中だけにしてください。

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
| `src-tauri/src/telemetry.rs` | ログとトレース (OpenTelemetry → Langfuse / OTLP) |
| `examples/time-mcp/` | 動作確認用の stdio MCP サーバー |

## 補足

- CopilotKit の表示では、`selfManagedAgents` は Enterprise tier の機能とされています。キーなしでも動作しますが、配布前にライセンス条件を確認してください。
- 過去のターンのツール呼び出しと結果は、次のターンではテキストとしてモデルに渡しています (プロバイダーのツール ID の整合を気にしなくて済むように)。
