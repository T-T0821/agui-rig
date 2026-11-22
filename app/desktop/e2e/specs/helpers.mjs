import { resolve } from "node:path";

const port = Number(process.env.MOCK_PORT ?? 9123);
const artifacts = resolve(import.meta.dirname, "..", "artifacts");
let shot = 0;

/** 模擬サーバーの設定を変える (利用上限など)。 */
export async function setMock(config) {
  const r = await fetch(`http://127.0.0.1:${port}/__mock/config`, { method: "PUT", body: JSON.stringify(config) });
  if (!r.ok) throw new Error(`模擬サーバーの設定に失敗: ${r.status}`);
}

/** 模擬サーバーが記録したトレース (プロキシの traceparent、Collector が受けたもの)。 */
export async function mockTraces() {
  const r = await fetch(`http://127.0.0.1:${port}/__mock/traces`);
  if (!r.ok) throw new Error(`模擬サーバーのトレースを読めません: ${r.status}`);
  return r.json();
}

/** 画面のスクリーンショットを e2e/artifacts/ に連番で残す。 */
export async function screenshot(name) {
  shot += 1;
  await browser.pause(500); // 描画が落ち着くのを待つ
  await browser.saveScreenshot(resolve(artifacts, `${String(shot).padStart(2, "0")}-${name}.png`));
}

/** テキストを含む要素 (子孫ではなく、その要素自身のテキストで探す)。 */
export const byText = (text, tag = "*") => $(`//${tag}[contains(normalize-space(text()), "${text}")]`);
export const allByText = (text, tag = "*") => $$(`//${tag}[contains(normalize-space(text()), "${text}")]`);
export const button = (label) => $(`//button[contains(normalize-space(.), "${label}")]`);

/** チャット欄にメッセージを入れて送る。 */
export async function send(message) {
  const input = await $("textarea");
  await input.waitForDisplayed();
  await input.setValue(message);
  await browser.keys("Enter");
}

/** ログアウトしてログインし直す (利用料金と利用上限を読み直させる)。 */
export async function relogin() {
  await (await button("ログアウト")).click();
  await (await button("ログイン")).waitForClickable();
  await (await button("ログイン")).click();
  await (await button("ログアウト")).waitForDisplayed();
}
