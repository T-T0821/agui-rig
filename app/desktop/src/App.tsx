import { useCallback, useEffect, useMemo, useState } from "react";
import { EventType, HttpAgent, type BaseEvent, type HttpAgentConfig, type Message, type RunAgentInput } from "@ag-ui/client";
import { of, type Observable } from "rxjs";
import { CopilotChat, CopilotKitProvider } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CircleUser,
  Loader2,
  LogIn,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Plus,
  Trash2,
  Wallet,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toolCallRenderers } from "./ToolCallCard";

type AgentEndpoint = { url: string; token: string };
type AuthStatus = { authRequired: boolean; loggedIn: boolean; user: string | null };
type ThreadSummary = { id: string; title: string; updatedAt: string };
type ThreadList = { enabled: boolean; threads: ThreadSummary[] };
type Usage = { todayUsd: number; monthUsd: number; monthStart: string };

const usd = (v: number) => (v > 0 && v < 0.01 ? "< $0.01" : `$${v < 10 ? v.toFixed(2) : v.toFixed(1)}`);
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
  const [usage, setUsage] = useState<Usage | null>(null);

  // 利用料金 (API Gateway → Lambda → Langfuse)。Langfuse の集計は少し遅れるので、定期的にも読み直す
  const refreshUsage = useCallback(() => {
    invoke<Usage | null>("usage_summary").then(setUsage, (e) => console.warn("利用料金を読めません", e));
  }, []);
  useEffect(() => {
    if (!auth?.loggedIn) return;
    refreshUsage();
    const timer = setInterval(refreshUsage, 60_000);
    return () => clearInterval(timer);
  }, [auth, refreshUsage]);

  // チャット履歴 (API Gateway → Lambda → DynamoDB)。Rust 側が ID トークンで読み書きする
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
    agent.subscribe({
      onRunFinalized: () => {
        refreshHistory();
        setTimeout(refreshUsage, 5_000);
      },
    });
    return { default: agent };
  }, [endpoint, conversation, refreshHistory, refreshUsage]);

  if (!auth || !agents) {
    return (
      <Center>
        {error ? (
          <p className="text-destructive text-sm">エラー: {error}</p>
        ) : (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            起動中…
          </p>
        )}
      </Center>
    );
  }

  if (auth.authRequired && !auth.loggedIn) {
    return (
      <Center>
        <Card className="w-full max-w-sm">
          <CardHeader className="justify-items-center text-center">
            <div className="bg-primary text-primary-foreground mb-2 flex size-11 items-center justify-center rounded-xl">
              <MessagesSquare className="size-5" />
            </div>
            <CardTitle className="text-xl">Rig Chat</CardTitle>
            <CardDescription>Auth0 のアカウントでログインしてください。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Button size="lg" className="w-full" disabled={busy} onClick={() => run("login")}>
              {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
              {busy ? "ブラウザでログインしてください…" : "ログイン"}
            </Button>
            {error && <p className="text-destructive text-center text-sm">{error}</p>}
          </CardContent>
        </Card>
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
      <TooltipProvider>
        <div className="flex h-full flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
            <div className="flex items-center gap-2 font-semibold">
              <div className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md">
                <MessagesSquare className="size-4" />
              </div>
              Rig Chat
            </div>
            <div className="ml-auto flex items-center gap-3">
              {usage && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="gap-1.5 font-normal">
                      <Wallet />
                      今日 {usd(usage.todayUsd)} · 今月 {usd(usage.monthUsd)}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-64">
                    Langfuse が計算した推定額です ({new Date(usage.monthStart).toLocaleDateString()} から)。請求額は AWS 側が正です。
                  </TooltipContent>
                </Tooltip>
              )}
              {auth.authRequired && (
                <>
                  <Separator orientation="vertical" className="!h-5" />
                  <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
                    <CircleUser className="size-4" />
                    {auth.user}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => run("logout")}>
                    <LogOut />
                    ログアウト
                  </Button>
                </>
              )}
            </div>
          </header>
          {error && (
            <div className="bg-destructive/10 text-destructive flex items-center gap-2 px-4 py-2 text-sm">
              <span className="flex-1">{error}</span>
              <Button variant="ghost" size="icon-sm" aria-label="閉じる" onClick={() => setError(undefined)}>
                <X />
              </Button>
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            {history.enabled && (
              <nav className="bg-sidebar text-sidebar-foreground flex w-64 shrink-0 flex-col border-r" aria-label="過去の会話">
                <div className="p-3">
                  <Button variant="outline" className="w-full justify-start" onClick={() => setConversation(newConversation())}>
                    <Plus />
                    新しい会話
                  </Button>
                </div>
                <p className="text-muted-foreground px-4 pb-1 text-xs font-medium">過去の会話</p>
                <ScrollArea className="min-h-0 flex-1">
                  <ul className="grid gap-0.5 px-2 pb-3">
                    {history.threads.length === 0 && (
                      <li className="text-muted-foreground px-2 py-1.5 text-sm">まだありません</li>
                    )}
                    {history.threads.map((t) => {
                      const active = t.id === conversation.threadId;
                      return (
                        <li key={t.id} className="group relative">
                          <button
                            className={cn(
                              "hover:bg-sidebar-accent flex w-full items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-left text-sm transition-colors",
                              active && "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
                            )}
                            title={`${t.title}\n${new Date(t.updatedAt).toLocaleString()}`}
                            onClick={() => openThread(t.id)}
                          >
                            <MessageSquare className="text-muted-foreground size-4 shrink-0" />
                            <span className="truncate">{t.title}</span>
                          </button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-destructive absolute top-1/2 right-1 size-7 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label={`「${t.title}」を削除`}
                            onClick={() => removeThread(t.id)}
                          >
                            <Trash2 />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </ScrollArea>
              </nav>
            )}
            <main className="min-w-0 flex-1">
              <CopilotChat
                agentId="default"
                threadId={conversation.threadId}
                labels={{ chatInputPlaceholder: "メッセージを入力…" }}
              />
            </main>
          </div>
        </div>
      </TooltipProvider>
    </CopilotKitProvider>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="bg-muted/40 grid h-full place-items-center p-6">{children}</div>;
}
