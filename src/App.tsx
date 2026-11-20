import { useCallback, useEffect, useMemo, useState } from "react";
import { HttpAgent } from "@ag-ui/client";
import { CopilotChat, CopilotKitProvider } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toolCallRenderers } from "./ToolCallCard";

type AgentEndpoint = { url: string; token: string };
type AuthStatus = { authRequired: boolean; loggedIn: boolean; user: string | null };

export default function App() {
  const [auth, setAuth] = useState<AuthStatus>();
  const [endpoint, setEndpoint] = useState<AgentEndpoint>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

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
    const agent = new HttpAgent({
      agentId: "default",
      url: endpoint.url,
      headers: { Authorization: `Bearer ${endpoint.token}` },
    });
    return { default: agent };
  }, [endpoint]);

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
    <CopilotKitProvider selfManagedAgents={agents} renderToolCalls={toolCallRenderers} enableInspector={false}>
      <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
        {auth.authRequired && (
          <header style={headerStyle}>
            <span>{auth.user}</span>
            <button style={linkStyle} onClick={() => run("logout")}>
              ログアウト
            </button>
          </header>
        )}
        <div style={{ flex: 1, minHeight: 0 }}>
          <CopilotChat agentId="default" labels={{ chatInputPlaceholder: "メッセージを入力…" }} />
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
