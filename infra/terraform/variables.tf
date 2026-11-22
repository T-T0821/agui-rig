variable "region" {
  description = "使うリージョン (アプリの AWS_REGION と同じ)"
  type        = string
  default     = "ap-northeast-1"
}

variable "name" {
  description = "作るリソースの名前の接頭辞"
  type        = string
  default     = "agui-rig"
}

# ---- 環境 (タグ) ----
# 開発者ごとの開発環境は ルートの `pnpm dev-env up` が environment = "dev"、owner = <ユーザ名> で作る

variable "environment" {
  description = "環境の名前 (全リソースの Environment タグ)。例: prod、dev"
  type        = string
  default     = "prod"
}

variable "permissions_boundary_arn" {
  description = "作る IAM ロールすべてに付ける権限の上限 (permissions boundary) のポリシー ARN。開発用アカウントでは infra/dev-account の出力。空なら付けない"
  type        = string
  default     = ""
}

variable "owner" {
  description = "この環境の持ち主 (全リソースの Owner タグ)。開発者ごとの環境ではユーザ名。空ならタグを付けない"
  type        = string
  default     = ""
}

# ---- ログイン (OpenID Connect) ----
# 本番は Auth0 (oidc_issuer と oidc_client_id を指定)。開発は create_cognito = true で Cognito のユーザープールを作って使える
# API Gateway のオーソライザーが、この issuer の ID トークンだけを受け付ける

variable "oidc_issuer" {
  description = "Auth0 の issuer (例 https://your-tenant.auth0.com/)。ID トークンの iss と末尾の / まで完全に一致させる。create_cognito = true なら空にする"
  type        = string
  default     = ""

  validation {
    condition     = var.oidc_issuer == "" || startswith(var.oidc_issuer, "https://")
    error_message = "oidc_issuer は https:// で始めてください。"
  }
}

variable "oidc_client_id" {
  description = "Auth0 の Client ID (ID トークンの aud)。create_cognito = true なら空にする"
  type        = string
  default     = ""
}

variable "create_cognito" {
  description = "開発用に Cognito のユーザープールとアプリクライアントを作り、Auth0 の代わりに使う"
  type        = bool
  default     = false
}

variable "cognito_domain_prefix" {
  description = "Cognito のログイン画面のドメインの接頭辞 (<接頭辞>.auth.<リージョン>.amazoncognito.com)。空なら <name>-<アカウント ID>"
  type        = string
  default     = ""
}

variable "cognito_callback_port" {
  description = "アプリがリダイレクトを受けるポート (アプリの OAUTH_REDIRECT_PORT と同じ値)"
  type        = number
  default     = 53682
}

# ---- LLM プロキシ (Bedrock / AgentCore を呼ぶのはサーバーの Lambda だけ) ----

variable "model_prices" {
  description = <<-EOT
    プロキシで呼べるモデル (Bedrock のモデル ID か推論プロファイル ID) と、100 万トークンあたりの USD 単価。
    ここに載っているモデルだけを呼べる (許可リストを兼ねる)。料金はこの単価 × Bedrock が返したトークン数で計算し、利用上限と画面の利用料金に使う。
    単価はリージョンや推論プロファイル (グローバル / リージョン) で変わるので、Bedrock の料金ページで確かめて入れる
  EOT
  type = map(object({
    input       = number
    output      = number
    cache_read  = optional(number, 0)
    cache_write = optional(number, 0)
  }))
  default = {
    # 既定のモデル。単価は Anthropic の公開価格 (入力 $2 / 出力 $10、キャッシュ読み $0.10、書き $2.50)。Bedrock の価格で確かめること
    "global.anthropic.claude-sonnet-5-5" = { input = 2, output = 10, cache_read = 0.1, cache_write = 2.5 }
  }
}

variable "max_output_tokens" {
  description = "1 回のモデル呼び出しの出力トークンの上限 (リクエストの値がこれより大きければ切り詰める)"
  type        = number
  default     = 16384
}

variable "bedrock_model_arns" {
  description = "プロキシの Lambda が呼んでよいモデル (推論プロファイルと基盤モデル) の ARN。空なら全モデル (*)。呼べるモデルは model_prices でも絞られる"
  type        = list(string)
  default     = []
}

variable "code_interpreter_id" {
  description = "プロキシが使う Code Interpreter (既定は AWS マネージドの aws.codeinterpreter.v1)。アプリからは変えられない"
  type        = string
  default     = "aws.codeinterpreter.v1"
}

variable "code_interpreter_arns" {
  description = "プロキシの Lambda が使ってよい Code Interpreter の ARN。空なら全部 (*)"
  type        = list(string)
  default     = []
}

variable "proxy_reserved_concurrency" {
  description = "プロキシの Lambda の同時実行数の上限 (全利用者の合計)。-1 なら設定しない"
  type        = number
  default     = -1
}

variable "authorizer_cache_ttl" {
  description = "オーソライザーの結果を API Gateway が使い回す秒数 (同じ ID トークンなら検証を省く)。0 なら毎回検証する"
  type        = number
  default     = 300

  validation {
    condition     = var.authorizer_cache_ttl >= 0 && var.authorizer_cache_ttl <= 3600
    error_message = "authorizer_cache_ttl は 0〜3600 にしてください。"
  }
}

# ---- チャット履歴 ----

variable "table_name" {
  description = "チャット履歴の DynamoDB テーブル名"
  type        = string
  default     = "agui-rig-chat-history"
}

variable "point_in_time_recovery" {
  description = "DynamoDB のポイントインタイムリカバリ (本番は true。使い捨ての開発環境は false で料金を抑える)"
  type        = bool
  default     = true
}

# ---- 利用料金と利用上限 ----

variable "utc_offset_minutes" {
  description = "「今日」「今月」の区切りに使うタイムゾーン (分)。日本は 540"
  type        = number
  default     = 540
}

variable "default_monthly_limit_usd" {
  description = "利用者 1 人あたりの月の利用上限 (USD、model_prices で計算した額)。0 なら上限なし。利用者ごとの上書きは pnpm limits"
  type        = number
  default     = 0

  validation {
    condition     = var.default_monthly_limit_usd >= 0
    error_message = "default_monthly_limit_usd は 0 以上にしてください。"
  }
}

variable "limit_warn_ratio" {
  description = "上限のこの割合を使ったら画面で警告する"
  type        = number
  default     = 0.8

  validation {
    condition     = var.limit_warn_ratio > 0 && var.limit_warn_ratio <= 1
    error_message = "limit_warn_ratio は 0 より大きく 1 以下にしてください。"
  }
}

# ---- API Gateway ----

variable "api_throttle_rate" {
  description = "API Gateway の 1 秒あたりのリクエスト数の上限 (全利用者の合計)"
  type        = number
  default     = 50
}

variable "api_throttle_burst" {
  description = "API Gateway の同時リクエスト数の上限"
  type        = number
  default     = 100
}
