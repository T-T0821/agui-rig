//! バックエンドの LLM プロキシ (API Gateway → Lambda → Bedrock) を、Rig のモデルとして使う。
//!
//! プロキシは OpenAI 互換の Chat Completions (`POST {CHAT_API_URL}/v1/chat/completions`、SSE) を話すので、
//! Rig の OpenAI 互換プロバイダー (Chat Completions の wire) を、base_url をプロキシに、API キーを ID トークンにして使う。
//! アプリは AWS の認証情報を持たない。呼べるモデル・出力の上限・利用上限・料金の記録はプロキシ側で決まる。
//!
//! ID トークンは 1 時間ごとに更新されるので、モデルはトークンが変わったときだけ作り直す (HTTP の接続は Rig の共有クライアントで使い回す)。
//!
//! プロキシへの要求には、その時点のスパン (モデル呼び出し 1 回分) の W3C `traceparent` を付ける。
//! プロキシはそれを親にして Langfuse の generation (トークン数・料金) を Collector に送るので、
//! Langfuse ではアプリのトレースの中にプロキシのモデル呼び出しが並ぶ。トレースを送っていないときは付かない。

use std::sync::{Arc, Mutex};

use opentelemetry::propagation::TextMapPropagator;
use opentelemetry_http::HeaderInjector;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use rig_core::DynModel;
use rig_core::http_client::{Exchange, HeaderMap, HttpMiddleware};
use rig_core::operation::Completion;
use rig_core::providers::openai::OpenAIConfig;
use rig_core::wasm_compat::WasmBoxedFuture;
use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::auth::IdToken;

/// 実行に使うモデル。ログイン中はプロキシ、開発モードでは直接 (Bedrock / LLM_MODEL)。
pub enum ModelSource {
    Fixed(Arc<DynModel<Completion>>),
    Proxy(LlmProxy),
}

impl ModelSource {
    /// 今使うモデル (プロキシなら、その時点の ID トークンを付けたもの)。
    pub fn get(&self) -> Arc<DynModel<Completion>> {
        match self {
            Self::Fixed(model) => model.clone(),
            Self::Proxy(proxy) => proxy.model(),
        }
    }

    /// トークン数と料金をプロキシがトレースに載せるか (アプリ側のスパンには載せない)。
    pub fn usage_traced_by_proxy(&self) -> bool {
        matches!(self, Self::Proxy(_))
    }
}

pub struct LlmProxy {
    /// `{CHAT_API_URL}/v1`
    base_url: String,
    model_id: String,
    token: IdToken,
    /// 最後に作ったモデルと、そのときの ID トークン
    cached: Mutex<Option<(String, Arc<DynModel<Completion>>)>>,
}

impl LlmProxy {
    pub fn new(api_url: &str, model_id: String, token: IdToken) -> Self {
        Self { base_url: base_url(api_url), model_id, token, cached: Mutex::new(None) }
    }

    fn model(&self) -> Arc<DynModel<Completion>> {
        let token = self.token.get();
        let mut cached = self.cached.lock().unwrap();
        if let Some((t, model)) = cached.as_ref()
            && *t == token
        {
            return model.clone();
        }
        let model: Arc<DynModel<Completion>> = Arc::new(
            OpenAIConfig::new(token.clone())
                .with_base_url(self.base_url.clone())
                .connect(rig_reqwest::shared().with_middleware(TraceParent))
                .chat(self.model_id.clone())
                .into(),
        );
        *cached = Some((token, model.clone()));
        model
    }
}

/// 要求ヘッダーに、今のスパンの `traceparent` を付ける。
/// Rig は要求をモデル呼び出しのスパンの中で送るので、そのスパンが親になる。
struct TraceParent;

impl HttpMiddleware for TraceParent {
    fn before_request_headers<'a>(&'a self, _exchange: Exchange<'a>, headers: &'a mut HeaderMap) -> WasmBoxedFuture<'a, rig_core::http_client::Result<()>> {
        inject_traceparent(headers);
        Box::pin(async { Ok(()) })
    }
}

fn inject_traceparent(headers: &mut HeaderMap) {
    let cx = tracing::Span::current().context();
    TraceContextPropagator::new().inject_context(&cx, &mut HeaderInjector(headers));
}

/// プロキシの base_url (Rig はこの後ろに `/chat/completions` を付ける)。
pub fn base_url(api_url: &str) -> String {
    format!("{}/v1", api_url.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_appends_v1() {
        assert_eq!(base_url("https://x.execute-api.ap-northeast-1.amazonaws.com/api/"), "https://x.execute-api.ap-northeast-1.amazonaws.com/api/v1");
        assert_eq!(base_url("http://127.0.0.1:9100/api"), "http://127.0.0.1:9100/api/v1");
    }
}
