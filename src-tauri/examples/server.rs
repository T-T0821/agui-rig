//! ウィンドウを出さずに AG-UI サーバーだけを起動する。
//!
//! ```sh
//! cargo run --example server
//! curl -N -X POST "$URL" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
//!   -d '{"threadId":"t1","runId":"r1","messages":[{"id":"m1","role":"user","content":"こんにちは"}],"tools":[],"context":[],"state":{},"forwardedProps":{}}'
//! ```

#[tokio::main]
async fn main() {
    rig_agui_chat_lib::run_headless().await;
}
