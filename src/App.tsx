import { useEffect, useMemo, useState } from "react";
import { HttpAgent } from "@ag-ui/client";
import { CopilotChat, CopilotKitProvider } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { invoke } from "@tauri-apps/api/core";

type AgentEndpoint = { url: string; token: string };

export default function App() {
  const [endpoint, setEndpoint] = useState<AgentEndpoint>();
  const [error, setError] = useState<string>();

  // Rust 側で起動した AG-UI サーバーの URL とトークンを受け取る
  useEffect(() => {
    invoke<AgentEndpoint>("agent_endpoint").then(setEndpoint, (e) => setError(String(e)));
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

  if (error) return <p style={{ padding: 16 }}>接続エラー: {error}</p>;
  if (!agents) return <p style={{ padding: 16 }}>起動中…</p>;

  return (
    <CopilotKitProvider selfManagedAgents={agents} enableInspector={false}>
      <div style={{ height: "100vh" }}>
        <CopilotChat agentId="default" labels={{ chatInputPlaceholder: "メッセージを入力…" }} />
      </div>
    </CopilotKitProvider>
  );
}
