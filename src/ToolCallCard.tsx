import { useState } from "react";
import { defineToolCallRenderer } from "@copilotkit/react-core/v2";
import { CheckCircle2, ChevronDown, Code2, Loader2, Plug, SquareTerminal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** ツール名を画面向けの表示名とアイコンにする。 */
function describe(name: string) {
  if (name === "code_interpreter_execute_code") return { label: "Code Interpreter: コード実行", Icon: Code2 };
  if (name === "code_interpreter_execute_command") return { label: "Code Interpreter: コマンド実行", Icon: SquareTerminal };
  const [server, tool] = name.split("__");
  return { label: tool ? `MCP ${server}: ${tool}` : name, Icon: Plug };
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

const preClass = "m-0 max-h-56 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all";

function ToolCard({ name, args, status, result }: { name: string; args: unknown; status: string; result?: string }) {
  const [open, setOpen] = useState(false);
  const done = status === "complete";
  const { label, Icon } = describe(name);
  const code = typeof args === "object" && args && "code" in args ? String((args as { code: unknown }).code) : undefined;
  return (
    <Collapsible
      open={open || !done}
      onOpenChange={setOpen}
      className="bg-card text-card-foreground my-2 overflow-hidden rounded-lg border text-sm shadow-xs"
    >
      <CollapsibleTrigger asChild>
        <button className="hover:bg-accent/60 flex w-full items-center gap-2 px-3 py-2 text-left transition-colors">
          {done ? (
            <CheckCircle2 className="text-success size-4 shrink-0" />
          ) : (
            <Loader2 className="text-warning size-4 shrink-0 animate-spin" />
          )}
          <Icon className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate font-medium">{label}</span>
          <Badge variant={done ? "secondary" : "outline"}>{done ? "完了" : "実行中…"}</Badge>
          <ChevronDown
            className={cn("text-muted-foreground ml-auto size-4 shrink-0 transition-transform", (open || !done) && "rotate-180")}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className={cn(preClass, "bg-muted/50 border-t")}>{code ?? JSON.stringify(args, null, 2)}</pre>
      </CollapsibleContent>
      {done && result !== undefined && (
        <pre className={cn(preClass, "bg-success/10 border-t")}>{output(result)}</pre>
      )}
    </Collapsible>
  );
}

/** すべてのツール呼び出しをカードで表示する。 */
export const toolCallRenderers = [
  defineToolCallRenderer({
    name: "*",
    render: ({ name, args, status, result }) => (
      <ToolCard name={name} args={args} status={String(status)} result={result as string | undefined} />
    ),
  }),
];
