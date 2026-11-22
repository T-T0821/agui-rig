//! ログとトレース。
//!
//! `tracing` で記録したものを、常に標準エラーへ出し、設定があれば OpenTelemetry (OTLP/HTTP) で送る。
//! Rig はモデル呼び出しごとに GenAI セマンティック規約のスパン (モデル名、トークン数など) を出すので、
//! このアプリが作る「チャット 1 回」「ツール呼び出し」のスパンの子として、そのまま Langfuse に載る。
//!
//! 送信先の決め方 (上から順に優先):
//! 1. `LANGFUSE_PUBLIC_KEY` と `LANGFUSE_SECRET_KEY` があれば Langfuse
//!    (`LANGFUSE_HOST`、既定 https://cloud.langfuse.com の `/api/public/otel/v1/traces`)
//! 2. `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` があれば、その OTLP 受け口
//!    (Collector 経由で Langfuse に送るときはこちら)。`TELEMETRY_AUTH=id_token` なら、
//!    ログイン中の ID トークンを `Authorization: Bearer` で付けて送る (Collector の oidc 認証で検証する)。
//!    ログイン前のスパンは送らない。リリースビルドでは送信先が https:// のときだけ使える
//! 3. どちらも無ければ送らない
//!
//! プロンプトや回答の本文は、`TELEMETRY_RECORD_CONTENT=true` のときだけ記録する。
//! 利用者 ID (ID トークンの sub) は、利用料金の集計に使うので常に記録する。
//!
//! LLM プロキシ経由のモデル呼び出しでは、トークン数と料金はプロキシが Langfuse の generation として送る
//! (このアプリのスパンの子になる)。二重に数えないよう、アプリ側のスパンからは送る前にトークン数を外す ([`UsageStripper`])。

use std::collections::HashMap;
use std::io::IsTerminal;
use std::sync::{OnceLock, RwLock};

use base64::Engine;
use async_trait::async_trait;
use opentelemetry::KeyValue;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_http::{Bytes, HttpClient, HttpError, Request, Response};
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::trace::{SdkTracerProvider, SpanData, SpanExporter as SpanExport};
use tracing_subscriber::{EnvFilter, Layer};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::auth::IdToken;

static PROVIDER: OnceLock<SdkTracerProvider> = OnceLock::new();
static RECORD_CONTENT: OnceLock<bool> = OnceLock::new();
/// トレースの送信に付ける ID トークン (ログイン中だけ)。
static ID_TOKEN: RwLock<Option<IdToken>> = RwLock::new(None);

/// ログインしたら Some、ログアウトしたら None を渡す。`TELEMETRY_AUTH=id_token` のときに使う。
/// ID トークンが更新されると、次の送信から新しいトークンが付く。
pub fn set_id_token(token: Option<IdToken>) {
    *ID_TOKEN.write().unwrap() = token;
}

/// 送信のたびに、その時点の ID トークンを付ける HTTP クライアント。
#[derive(Debug)]
struct IdTokenClient(reqwest::blocking::Client);

#[async_trait]
impl HttpClient for IdTokenClient {
    async fn send_bytes(&self, mut request: Request<Bytes>) -> Result<Response<Bytes>, HttpError> {
        let token = ID_TOKEN.read().unwrap().as_ref().map(IdToken::get);
        let Some(token) = token else {
            // ログイン前 (またはログアウト後) は Collector が受け付けないので、送らずに捨てる
            return Ok(Response::builder().status(200).body(Bytes::new())?);
        };
        request.headers_mut().insert(reqwest::header::AUTHORIZATION, format!("Bearer {token}").parse()?);
        self.0.send_bytes(request).await
    }
}

/// このフィールドが `proxy` のスパンは、トークン数をプロキシ側のスパンが持つ (アプリ側では送らない)。
pub const USAGE_TRACED_BY: &str = "agui.usage_traced_by";

/// 送る前に、プロキシがトークン数を載せるスパンから `gen_ai.usage.*` を外す。
/// Rig はモデル呼び出しのスパンに必ずトークン数を書くので、スパンの側では止められない。
#[derive(Debug)]
struct UsageStripper<E>(E);

fn strip_proxy_usage(span: &mut SpanData) {
    let by_proxy = span.attributes.iter().any(|kv| kv.key.as_str() == USAGE_TRACED_BY && kv.value.as_str() == "proxy");
    if by_proxy {
        span.attributes.retain(|kv| !kv.key.as_str().starts_with("gen_ai.usage.") && kv.key.as_str() != "langfuse.observation.usage_details");
    }
}

impl<E: SpanExport> SpanExport for UsageStripper<E> {
    fn export(&self, mut batch: Vec<SpanData>) -> impl std::future::Future<Output = OTelSdkResult> + Send {
        batch.iter_mut().for_each(strip_proxy_usage);
        self.0.export(batch)
    }
    fn shutdown_with_timeout(&self, timeout: std::time::Duration) -> OTelSdkResult {
        self.0.shutdown_with_timeout(timeout)
    }
    fn force_flush(&self) -> OTelSdkResult {
        self.0.force_flush()
    }
    fn set_resource(&mut self, resource: &Resource) {
        self.0.set_resource(resource)
    }
}

/// プロンプト・回答・ツールの入出力をトレースに含めるか。
pub fn record_content() -> bool {
    *RECORD_CONTENT.get_or_init(|| {
        std::env::var("TELEMETRY_RECORD_CONTENT").is_ok_and(|v| matches!(v.as_str(), "1" | "true" | "yes"))
    })
}

/// 送信先の設定。どれも無ければ None。
fn exporter() -> Result<Option<(SpanExporter, String)>, String> {
    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());

    if let (Some(pk), Some(sk)) = (var("LANGFUSE_PUBLIC_KEY"), var("LANGFUSE_SECRET_KEY")) {
        let host = var("LANGFUSE_HOST").unwrap_or_else(|| "https://cloud.langfuse.com".into());
        let endpoint = format!("{}/api/public/otel/v1/traces", host.trim_end_matches('/'));
        let auth = base64::engine::general_purpose::STANDARD.encode(format!("{pk}:{sk}"));
        let exporter = SpanExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .with_endpoint(&endpoint)
            .with_headers(HashMap::from([("Authorization".to_string(), format!("Basic {auth}"))]))
            .build()
            .map_err(|e| e.to_string())?;
        return Ok(Some((exporter, format!("Langfuse ({host})"))));
    }

    if let Some(endpoint) = var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").or_else(|| var("OTEL_EXPORTER_OTLP_ENDPOINT")) {
        // エンドポイントとヘッダーは OTEL_EXPORTER_OTLP_* 環境変数から SDK が読む
        let builder = SpanExporter::builder().with_http().with_protocol(Protocol::HttpBinary);
        let auth = var("TELEMETRY_AUTH");
        let (builder, target) = match auth.as_deref() {
            None => (builder, "OTLP".to_string()),
            Some("id_token") => {
                if !cfg!(debug_assertions) && !endpoint.starts_with("https://") {
                    return Err("TELEMETRY_AUTH=id_token では、ID トークンを守るため送信先を https:// にしてください".into());
                }
                (builder.with_http_client(IdTokenClient(blocking_client()?)), "OTLP (ID トークンで認証)".to_string())
            }
            Some(other) => return Err(format!("TELEMETRY_AUTH={other} は使えません (id_token か、未設定)")),
        };
        let exporter = builder.build().map_err(|e| e.to_string())?;
        return Ok(Some((exporter, target)));
    }

    Ok(None)
}

/// reqwest のブロッキングクライアントは非同期ランタイムの中では作れないので、別スレッドで作る。
fn blocking_client() -> Result<reqwest::blocking::Client, String> {
    std::thread::spawn(|| reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(10)).build())
        .join()
        .map_err(|_| "HTTP クライアントを作れません".to_string())?
        .map_err(|e| e.to_string())
}

/// ログとトレースを初期化する。起動時に 1 回だけ呼ぶ。
/// ログの詳しさは `RUST_LOG` で変えられる (既定は info)。
pub fn init() {
    let filter = || EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let fmt = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal())
       .with_filter(filter());

    let (otel, note) = match exporter() {
        Ok(Some((exporter, target))) => {
            let provider = SdkTracerProvider::builder()
                .with_batch_exporter(UsageStripper(exporter))
                .with_resource(
                    Resource::builder()
                        .with_service_name("rig-agui-chat")
                        .with_attribute(KeyValue::new("service.version", env!("CARGO_PKG_VERSION")))
                        .build(),
                )
                .build();
            let tracer = provider.tracer("rig-agui-chat");
            let _ = PROVIDER.set(provider);
            // 送るのはこのアプリと Rig のスパンだけ (HTTP クライアントなどの細かいスパンは送らない)
            let layer = tracing_opentelemetry::layer()
                .with_tracer(tracer)
                .with_filter(EnvFilter::new("warn,rig_agui_chat_lib=info,rig=info,rig_core=info"));
            (Some(layer), Some(target))
        }
        Ok(None) => (None, None),
        Err(e) => (None, Some(format!("無効 (設定エラー: {e})"))),
    };

    tracing_subscriber::registry().with(fmt).with(otel).init();
    match note {
        Some(target) => tracing::info!(content = record_content(), "トレースの送信先: {target}"),
        None => tracing::info!("トレースの送信先が未設定なので、ログは標準エラーにだけ出します"),
    }
}

/// 残っているスパンを送ってから終了する。アプリの終了時に呼ぶ。
pub fn shutdown() {
    if let Some(provider) = PROVIDER.get()
        && let Err(e) = provider.shutdown()
    {
        eprintln!("[telemetry] 送信しきれなかったトレースがあります: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::trace::{SpanContext, SpanKind, Status};
    use std::time::SystemTime;

    fn span(attrs: Vec<KeyValue>) -> SpanData {
        SpanData {
            span_context: SpanContext::empty_context(),
            parent_span_id: opentelemetry::trace::SpanId::INVALID,
            parent_span_is_remote: false,
            span_kind: SpanKind::Internal,
            name: "chat".into(),
            start_time: SystemTime::now(),
            end_time: SystemTime::now(),
            attributes: attrs,
            dropped_attributes_count: 0,
            events: Default::default(),
            links: Default::default(),
            status: Status::Unset,
            instrumentation_scope: Default::default(),
        }
    }

    #[test]
    fn strips_usage_only_when_proxy_traces_it() {
        let usage = || vec![KeyValue::new("gen_ai.usage.input_tokens", 10), KeyValue::new("gen_ai.request.model", "m")];

        let mut s = span([usage(), vec![KeyValue::new(USAGE_TRACED_BY, "proxy")]].concat());
        strip_proxy_usage(&mut s);
        let keys: Vec<_> = s.attributes.iter().map(|kv| kv.key.as_str().to_string()).collect();
        assert_eq!(keys, ["gen_ai.request.model", USAGE_TRACED_BY]);

        let mut s = span(usage());
        strip_proxy_usage(&mut s);
        assert_eq!(s.attributes.len(), 2);
    }
}
