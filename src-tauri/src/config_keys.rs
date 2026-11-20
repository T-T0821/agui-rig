// 設定ファイル (埋め込み・アプリ設定フォルダ) に書けるキーの一覧。build.rs と config.rs の両方で使う。
// 値はどれも環境変数と同じ名前・同じ意味。

/// 設定ファイルに書ける (秘密でない) キー。
pub const CONFIG_KEYS: &[&str] = &[
    "OAUTH_ISSUER",
    "OAUTH_CLIENT_ID",
    "OAUTH_SCOPES",
    "OAUTH_REDIRECT_PORT",
    "AWS_REGION",
    "AWS_ROLE_ARN",
    "AWS_ENDPOINT_URL_STS",
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
    "AWS_ENDPOINT_URL_BEDROCK_AGENTCORE",
    "BEDROCK_MODEL_ID",
    "CODE_INTERPRETER_ID",
    "MCP_CONFIG",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "LANGFUSE_HOST",
    "TELEMETRY_RECORD_CONTENT",
    "RUST_LOG",
];

/// 設定ファイルには書けない秘密情報。環境変数 (開発中は .env) でだけ渡す。
pub const SECRET_KEYS: &[&str] = &[
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    "ANTHROPIC_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
];
