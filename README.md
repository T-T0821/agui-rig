# Rig AG-UI Chat

React + CopilotKit のチャット UI を Tauri 2 のデスクトップアプリに載せ、LLM 呼び出しは Rust の Rig (rig-core) で行う最小構成のサンプルです。フロントとバックエンドは AG-UI プロトコルでつなぎ、CopilotKit の Node ランタイム (CopilotRuntime) は使いません。

## 構成

```
┌──────────── Tauri アプリ (1 プロセス) ─────────────────────────────┐
│                                                                    │
│  WebView (React)                       Rust                        │
│  ┌───────────────────────┐             ┌────────────────────────┐  │
│  │ CopilotChat           │  invoke     │ agent_endpoint コマンド │  │
│  │ CopilotKitProvider    │ ──────────▶ │  → URL とトークンを返す │  │
│  │  selfManagedAgents:   │             └────────────────────────┘  │
│  │   HttpAgent           │  POST /agent (RunAgentInput)            │
│  │   (@ag-ui/client)     │ ──────────▶ ┌────────────────────────┐  │
│  │                       │ ◀────────── │ axum (127.0.0.1:空き)   │  │
│  └───────────────────────┘  SSE で     │  AG-UI イベントに変換   │  │
│                             AG-UI      │        ▲               │  │
│                             イベント   │  Rig (DynModel.stream) │──┼─▶ LLM API
│                                        └────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

1. 起動時に Rust が `127.0.0.1` の空きポートで axum サーバーを立て、起動ごとのランダムなトークンを作る。
2. フロントは Tauri コマンド `agent_endpoint` で URL とトークンを受け取り、`HttpAgent` を作って `CopilotKitProvider` の `selfManagedAgents` に渡す。
3. 送信すると HttpAgent が `RunAgentInput` を POST する。Rust は会話履歴を Rig の `CompletionRequest` に変換し、`DynModel::stream` のテキスト差分を AG-UI イベントにして SSE で返す。

返すイベントは `RUN_STARTED` → `TEXT_MESSAGE_START` → `TEXT_MESSAGE_CONTENT` (差分ごと) → `TEXT_MESSAGE_END` → `RUN_FINISHED` (失敗時は `RUN_ERROR`) です。停止ボタンで接続が切れると、Rust 側の LLM ストリームも止まります。

## ファイル

| パス | 内容 |
| --- | --- |
| `src/App.tsx` | CopilotKit (v2 API) と HttpAgent の設定 |
| `src-tauri/src/lib.rs` | モデル接続、サーバー起動、`agent_endpoint` コマンド |
| `src-tauri/src/server.rs` | `POST /agent` (認証、SSE、切断時のキャンセル) |
| `src-tauri/src/agent.rs` | AG-UI 入力 → Rig リクエスト、Rig ストリーム → AG-UI イベント |
| `src-tauri/src/agui.rs` | AG-UI の型 (入力は寛容に受け、出力はプロトコルどおり) |
| `src-tauri/examples/server.rs` | ウィンドウなしでサーバーだけ起動 (curl での確認用) |

## 動かし方

必要なもの: Node.js 20 以上、Rust 1.97.1 以上 (rig-core 0.46 の要件)、[Tauri の前提パッケージ](https://v2.tauri.app/start/prerequisites/)。

```sh
npm install
cp .env.example .env   # LLM_MODEL と API キーを設定
npm run tauri dev
```

モデルは `LLM_MODEL` に `vendor/model` 形式で指定します (Rig の `Catalog::builtin().connect`)。API キーはベンダーごとの環境変数 (`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` など) から読まれます。OpenAI 互換のプロキシを使う場合は `OPENAI_BASE_URL` も使えます。

バックエンドだけ試す場合:

```sh
cd src-tauri
cargo run --example server   # URL とトークンが表示される
curl -N -X POST "$URL" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"threadId":"t1","runId":"r1","messages":[{"id":"m1","role":"user","content":"こんにちは"}],"tools":[],"context":[],"state":{},"forwardedProps":{}}'
```

## 補足

- バージョン: CopilotKit 1.89 (`@copilotkit/react-core/v2`)、@ag-ui/client 1.0.5、Tauri 2.12、rig-core 0.46。
- CopilotKit のライセンス: `selfManagedAgents` (ランタイムを介さず自前のエージェントを渡す機能) は、CopilotKit 側の表示では Enterprise Intelligence tier の機能とされています。ライセンスキーなしでも動作しますが、本番配布の前に条件を確認してください。
- セキュリティ: サーバーは `127.0.0.1` にのみバインドし、起動ごとのトークンを `Authorization` ヘッダーで確認します。CORS は WebView のオリジン (`http://localhost:1420`、`tauri://localhost` など) から呼べるよう緩めています。
- AG-UI のメッセージのうち `user` / `assistant` / `system` / `developer` のテキストだけを LLM に送ります。`useAgentContext` などで渡される `context` はシステムプロンプトに追記します。ツール呼び出しは未対応です。

## 次の拡張: stdio MCP サーバーのツールを使う

LLM を呼ぶのは Rust プロセス (ユーザーの PC 上) なので、stdio の MCP サーバーを子プロセスとして起動して使えます。

1. `rmcp` または `rig-mcp-client` で MCP サーバーを起動し、ツール一覧を取得する。
2. それを Rig の `ToolDefinition` にして `CompletionRequest` に渡す。
3. モデルがツールを呼んだら MCP で実行し、結果を履歴に足して再度呼ぶ (ツールループ)。
4. その過程を AG-UI の `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` / `TOOL_CALL_RESULT` で流すと、CopilotChat 上にツール実行が表示される。
