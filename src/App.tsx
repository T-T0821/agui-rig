import { useCallback, useEffect, useMemo, useState } from "react";
import { EventType, HttpAgent, type BaseEvent, type HttpAgentConfig, type Message, type RunAgentInput } from "@ag-ui/client";
import { of, type Observable } from "rxjs";
import { CopilotChat, CopilotKitProvider } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toolCallRenderers } from "./ToolCallCard";

type AgentEndpoint = { url: string; token: string };
type AuthStatus = { authRequired: boolean; loggedIn: boolean; user: string | null };
type ThreadSummary = { id: string; title: string; updatedAt: string };
type ThreadList = { enabled: boolean; threads: ThreadSummary[] };
/** 表示中の会話。切り替えるときは agent ごと作り直す */
type Conversation = { threadId: string; messages: Message[] };

const newConversation = (): Conversation => ({ threadId: crypto.randomUUID(), messages: [] });

/**
 * HttpAgent に「接続 (connect)」を足したもの。CopilotChat は会話を開くときに connect を呼ぶので、
 * 保存済みのメッセージを MESSAGES_SNAPSHOT として返して画面に復元する。
 */
class HistoryAgent extends HttpAgent {
  constructor(
    config: HttpAgentConfig,
    private saved: Message[],
  ) {
    super(config);
  }

  protected connect(input: RunAgentInput): Observable<BaseEvent> {
    const messages = this.saved;
    return of(
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent,
      { type: EventType.MESSAGES_SNAPSHOT, messages } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent,
    );
  }
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus>();
  const [endpoint, setEndpoint] = useState<AgentEndpoint>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [conversation, setConversation] = useState<Conversation>(newConversation);
  const [history, setHistory] = useState<ThreadList>({ enabled: false, threads: [] });

  // チャット履歴 (AppSync)。Rust 側が ID トークンで読み書きする
  const refreshHistory = useCallback(() => {
    invoke<ThreadList>("list_threads").then(setHistory, (e) => console.warn("履歴を読めません", e));
  }, []);
  useEffect(() => {
    if (auth?.loggedIn || (auth && !auth.authRequired)) refreshHistory();
  }, [auth, refreshHistory]);

  const openThread = useCallback(async (threadId: string) => {
    try {
      const messages = await invoke<Message[]>("load_thread", { threadId });
      setConversation({ threadId, messages });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const removeThread = useCallback(
    async (threadId: string) => {
      try {
        await invoke("delete_thread", { threadId });
        if (threadId === conversation.threadId) setConversation(newConversation());
        refreshHistory();
      } catch (e) {
        setError(String(e));
      }
    },
    [conversation.threadId, refreshHistory],
  );

  // ログイン状態 (トークン自体は Rust 側が持ち、ここには来ない)
  useEffect(() => {
    invoke<AuthStatus>("auth_status").then(setAuth, (e) => setError(String(e)));
    const unlisten = listen("auth-changed", () => invoke<AuthStatus>("auth_status").then(setAuth));
    return () => void unlisten.then((f) => f());
  }, []);

  // Rust (Rig) の AG-UI エンドポイント
  useEffect(() => {
    invoke<AgentEndpoint>("agent_endpoint").then(setEndpoint, (e) => setError(String(e)));
  }, []);

  const run = useCallback(async (command: "login" | "logout") => {
    setBusy(true);
    setError(undefined);
    try {
      setAuth(await invoke<AuthStatus>(command));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // CopilotKit の Node ランタイムは使わず、HttpAgent で Rust (Rig) の AG-UI エンドポイントへ直接つなぐ
  const agents = useMemo(() => {
    if (!endpoint) return undefined;
    const agent = new HistoryAgent(
      {
        agentId: "default",
        url: endpoint.url,
        headers: { Authorization: `Bearer ${endpoint.token}` },
        threadId: conversation.threadId,
        initialMessages: conversation.messages,
      },
      conversation.messages,
    );
    // 1 回の実行が終わるたびに (Rust 側で保存済み) 一覧を読み直す
    agent.subscribe({ onRunFinalized: () => refreshHistory() });
    return { default: agent };
  }, [endpoint, conversation, refreshHistory]);

  if (!auth || !agents) {
    return <Center>{error ? `エラー: ${error}` : "起動中…"}</Center>;
  }

  if (auth.authRequired && !auth.loggedIn) {
    return (
      <Center>
        <h2 style={{ margin: 0 }}>Rig Chat</h2>
        <p>共通基盤のアカウントでログインしてください。</p>
        <button style={buttonStyle} disabled={busy} onClick={() => run("login")}>
          {busy ? "ブラウザでログインしてください…" : "ログイン"}
        </button>
        {error && <p style={{ color: "#c00" }}>{error}</p>}
      </Center>
    );
  }

  return (
    <CopilotKitProvider
      key={conversation.threadId}
      selfManagedAgents={agents}
      renderToolCalls={toolCallRenderers}
      enableInspector={false}
    >
      <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
        {auth.authRequired && (
          <header style={headerStyle}>
            <span>{auth.user}</span>
            <button style={linkStyle} onClick={() => run("logout")}>
              ログアウト
            </button>
          </header>
        )}
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {history.enabled && (
            <nav style={sidebarStyle} aria-label="過去の会話">
              <button style={newButtonStyle} onClick={() => setConversation(newConversation())}>
                ＋ 新しい会話
              </button>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, overflowY: "auto" }}>
                {history.threads.map((t) => (
                  <li key={t.id} style={{ display: "flex", alignItems: "center" }}>
                    <button
                      style={{ ...threadStyle, ...(t.id === conversation.threadId ? activeThreadStyle : {}) }}
                      title={`${t.title}\n${new Date(t.updatedAt).toLocaleString()}`}
                      onClick={() => openThread(t.id)}
                    >
                      {t.title}
                    </button>
                    <button style={deleteStyle} aria-label={`「${t.title}」を削除`} onClick={() => removeThread(t.id)}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <CopilotChat
              agentId="default"
              threadId={conversation.threadId}
              labels={{ chatInputPlaceholder: "メッセージを入力…" }}
            />
          </div>
        </div>
      </div>
    </CopilotKitProvider>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: "100vh", display: "grid", placeItems: "center", fontFamily: "sans-serif" }}>
      <div style={{ textAlign: "center", display: "grid", gap: 12 }}>{children}</div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "10px 24px",
  borderRadius: 999,
  border: "none",
  background: "#111",
  color: "#fff",
  fontSize: 15,
  cursor: "pointer",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  alignItems: "center",
  gap: 12,
  padding: "8px 16px",
  fontFamily: "sans-serif",
  fontSize: 13,
  color: "#555",
  borderBottom: "1px solid #eee",
};
const linkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#2563eb",
  cursor: "pointer",
  fontSize: 13,
};
const sidebarStyle: React.CSSProperties = {
  width: 220,
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  borderRight: "1px solid #eee",
  fontFamily: "sans-serif",
  fontSize: 13,
};
const newButtonStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid #ddd",
  background: "#fff",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 13,
};
const threadStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "6px 8px",
  border: "none",
  borderRadius: 6,
  background: "none",
  textAlign: "left",
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  fontSize: 13,
  color: "#333",
};
const activeThreadStyle: React.CSSProperties = { background: "#f0f0f0", fontWeight: 600 };
const deleteStyle: React.CSSProperties = {
  border: "none",
  background: "none",
  color: "#999",
  cursor: "pointer",
  fontSize: 14,
  padding: "4px 6px",
};
