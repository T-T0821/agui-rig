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
//!    (ヘッダーは `OTEL_EXPORTER_OTLP_HEADERS`。Collector 経由で Langfuse に送るときはこちら)
//! 3. どちらも無ければ送らない
//!
//! プロンプトや回答の本文は、`TELEMETRY_RECORD_CONTENT=true` のときだけ記録する。
//! 利用者 ID (ID トークンの sub) は、利用料金の集計に使うので常に記録する。

use std::collections::HashMap;
use std::io::IsTerminal;
use std::sync::OnceLock;

use base64::Engine;
use opentelemetry::KeyValue;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing_subscriber::{EnvFilter, Layer};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

static PROVIDER: OnceLock<SdkTracerProvider> = OnceLock::new();
static RECORD_CONTENT: OnceLock<bool> = OnceLock::new();

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

    if var("OTEL_EXPORTER_OTLP_ENDPOINT").is_some() || var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").is_some() {
        // エンドポイントとヘッダーは OTEL_EXPORTER_OTLP_* 環境変数から SDK が読む
        let exporter = SpanExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .build()
            .map_err(|e| e.to_string())?;
        return Ok(Some((exporter, "OTLP".into())));
    }

    Ok(None)
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
                .with_batch_exporter(exporter)
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
