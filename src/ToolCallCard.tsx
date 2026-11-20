import { useState } from "react";
import { defineToolCallRenderer } from "@copilotkit/react-core/v2";

/** ツール名を画面向けの表示名にする。 */
function label(name: string) {
  if (name === "code_interpreter_execute_code") return "Code Interpreter: コード実行";
  if (name === "code_interpreter_execute_command") return "Code Interpreter: コマンド実行";
  const [server, tool] = name.split("__");
  return tool ? `MCP ${server}: ${tool}` : name;
}

/** Code Interpreter の結果 (JSON) から、見せたい出力だけを取り出す。 */
function output(result: string) {
  try {
    const r = JSON.parse(result);
    return String(r.result?.stdout || r.output || r.result?.stderr || result);
  } catch {
    return result;
  }
}

function Card({ name, args, status, result }: { name: string; args: unknown; status: string; result?: string }) {
  const [open, setOpen] = useState(false);
  const done = status === "complete";
  const code = typeof args === "object" && args && "code" in args ? String((args as { code: unknown }).code) : undefined;
  return (
    <div style={card}>
      <button style={header} onClick={() => setOpen(!open)}>
        <span style={{ ...dot, background: done ? "#16a34a" : "#f59e0b" }} />
        <strong>{label(name)}</strong>
        <span style={{ color: "#666" }}>{done ? "完了" : "実行中…"}</span>
        <span style={{ marginLeft: "auto", color: "#999" }}>{open ? "▲" : "▼"}</span>
      </button>
      {(open || !done) && (
        <pre style={pre}>{code ?? JSON.stringify(args, null, 2)}</pre>
      )}
      {done && result !== undefined && <pre style={{ ...pre, background: "#f0fdf4" }}>{output(result)}</pre>}
    </div>
  );
}

/** すべてのツール呼び出しをカードで表示する。 */
export const toolCallRenderers = [
  defineToolCallRenderer({
    name: "*",
    render: ({ name, args, status, result }) => (
      <Card name={name} args={args} status={String(status)} result={result as string | undefined} />
    ),
  }),
];

const card: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 10,
  margin: "8px 0",
  overflow: "hidden",
  fontSize: 13,
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "8px 12px",
  background: "#fafafa",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 13,
};
const dot: React.CSSProperties = { width: 8, height: 8, borderRadius: 999, flexShrink: 0 };
const pre: React.CSSProperties = {
  margin: 0,
  padding: "8px 12px",
  background: "#f8fafc",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  fontSize: 12,
  maxHeight: 220,
  overflow: "auto",
};
