import { byText, screenshot, send } from "../helpers.mjs";

// 本物の Bedrock / AgentCore を呼ぶ (費用がかかる)。ログインは省略 (DEV_SKIP_LOGIN=1) するので、
// チャット履歴と利用料金 (API Gateway) は使われない。それは pnpm smoke:aws で ID トークンを渡して確かめる。
describe("本物の AWS: ログインなしの開発モードでチャット", () => {
  it("Bedrock のモデルが回答し、Code Interpreter で計算できる", async () => {
    await (await $("textarea")).waitForDisplayed();
    await screenshot("aws-start");
    await send("Code Interpreter で 12345 * 6789 を計算して、結果の数字だけを答えてください。");
    // 12345 * 6789 = 83810205。モデルが桁区切りを付けることもある
    await browser.waitUntil(
      async () => /83,?810,?205/.test(await (await $("main")).getText()),
      { timeout: 120_000, timeoutMsg: "回答に 83810205 が出ません" },
    );
    await (await byText("Code Interpreter: コード実行")).waitForDisplayed();
    await screenshot("aws-answer");
  });
});
