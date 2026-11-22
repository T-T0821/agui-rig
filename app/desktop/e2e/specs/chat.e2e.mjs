import { allByText, button, byText, mockTraces, relogin, screenshot, send, setMock } from "./helpers.mjs";

const ANSWER = "LLM プロキシの模擬応答です";

describe("模擬環境: ログイン → チャット (ツール) → 履歴 → 利用料金と上限", () => {
  before(async () => {
    await setMock({ monthlyLimitUsd: null });
  });

  it("ログイン画面から模擬の Auth0 でログインできる", async () => {
    await (await byText("Auth0 のアカウントでログイン")).waitForDisplayed();
    const login = await button("ログイン");
    await login.waitForClickable();
    await screenshot("login");
    await login.click();
    // 模擬サーバーがすぐにリダイレクトし、ID トークンを受け取ると利用者名が出る
    await (await byText("模擬 太郎")).waitForDisplayed();
    await (await button("ログアウト")).waitForDisplayed();
    await screenshot("logged-in");
  });

  it("送ったメッセージに、MCP の時刻ツールと Code Interpreter を使って回答する", async () => {
    await send("東京の今の時刻と、年末までの日数を教えて");
    await (await byText(ANSWER)).waitForDisplayed({ timeout: 60_000 });
    await (await byText("get_current_time")).waitForDisplayed();
    await (await byText("Code Interpreter: コード実行")).waitForDisplayed();
    // 2 つのツールが両方「完了」になり、ツールの結果が回答に入る
    await browser.waitUntil(async () => (await allByText("完了")).length === 2 && (await allByText("実行中")).length === 0);
    // 回答の最後 (2 つ目のツールの結果) まで流れ切るのを待つ (ツールの表示と回答の 2 か所に出る)
    await browser.waitUntil(async () => (await allByText("実行はしていません")).length >= 2);
    await screenshot("chat-with-tools");
  });

  it("プロキシのモデル呼び出しが Langfuse の generation としてアプリのトレースにつながり、トークン数は二重に送らない", async () => {
    // 筋書きはモデル呼び出し 3 回 (時刻ツール → Code Interpreter → 回答)
    let t = await mockTraces();
    expect(t.proxyCalls.length).toBe(3);
    // アプリはプロキシへの要求ごとに traceparent を付け、どれも同じトレース (チャット 1 回) に入る
    for (const c of t.proxyCalls) expect(c.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(new Set(t.proxyCalls.map((c) => c.traceId)).size).toBe(1);
    // プロキシの generation は、そのトレースの子として Collector に届く (利用者は ID トークンの sub)
    await browser.waitUntil(async () => (await mockTraces()).generations.length === 3, { timeout: 10_000 });
    t = await mockTraces();
    for (const g of t.generations) {
      expect(g.traceId).toBe(t.proxyCalls[0].traceId);
      expect(g.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
      expect(g.sub).toBe("mock-user-001");
      expect(g.attrs["langfuse.observation.type"]).toBe("generation");
    }
    // アプリのスパン (バッチで数秒後に届く) は同じトレースで、トークン数は外してある
    await browser.waitUntil(async () => (await mockTraces()).appExports.some((e) => e.traceIds.length > 0), { timeout: 20_000 });
    const app = (await mockTraces()).appExports.filter((e) => e.traceIds.length > 0);
    expect(app.some((e) => e.usageTracedByProxy)).toBe(true);
    expect(app.every((e) => !e.hasUsage)).toBe(true);
  });

  it("会話が履歴に保存され、新しい会話から戻って開き直せる", async () => {
    const nav = await $('nav[aria-label="過去の会話"]');
    const item = await nav.$('.//button[contains(., "東京の今の時刻")]');
    await item.waitForDisplayed();

    await (await button("新しい会話")).click();
    await (await byText(ANSWER)).waitForDisplayed({ reverse: true });
    await screenshot("new-conversation");

    await item.click();
    await (await byText(ANSWER)).waitForDisplayed();
    await (await byText("Code Interpreter: コード実行")).waitForDisplayed();
    await screenshot("history-restored");
  });

  it("利用料金をヘッダーに出し、上限に近づくと警告する", async () => {
    // 模擬の利用料金は $1.234 + やり取りごとの模擬額。実行の 5 秒後に読み直される
    const badge = await byText("今日");
    await badge.waitForDisplayed({ timeout: 20_000 });
    await browser.waitUntil(async () => /今月 \$1\.2\d/.test(await badge.getText()), { timeout: 20_000 });

    await setMock({ monthlyLimitUsd: 1.5 });
    await relogin();
    await (await $("div*=に近づいています")).waitForDisplayed();
    await browser.waitUntil(async () => (await (await byText("今日")).getText()).includes("上限"), { timeout: 10_000 });
    await screenshot("usage-warn");
  });

  it("上限に達すると、画面に知らせてメッセージを送らせない", async () => {
    await setMock({ monthlyLimitUsd: 1.0 });
    await relogin();
    await (await $('[role="alert"]')).waitForDisplayed();
    expect(await (await $('[role="alert"]')).getText()).toContain("利用上限 ($1.00) に達した");

    const before = (await allByText(ANSWER)).length;
    await send("上限に達していても送れますか？");
    // Rust 側がモデルを呼ぶ前に止めるので、新しい回答は増えない
    await (await byText("上限に達していても送れますか")).waitForDisplayed();
    await browser.pause(5_000);
    expect((await allByText(ANSWER)).length).toBe(before);
    await screenshot("usage-blocked");
  });
});
