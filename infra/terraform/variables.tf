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

variable "owner" {
  description = "この環境の持ち主 (全リソースの Owner タグ)。開発者ごとの環境ではユーザ名。空ならタグを付けない"
  type        = string
  default     = ""
}

# ---- ログイン (OpenID Connect) ----
# 本番は Auth0 (oidc_issuer と oidc_client_id を指定)。開発は create_cognito = true で Cognito のユーザープールを作って使える

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

# ---- アプリが引き受ける IAM ロール (Bedrock / AgentCore) ----

variable "create_oidc_provider" {
  description = "IAM の OIDC プロバイダーを作るか。同じ issuer のプロバイダーが既にアカウントにあれば false にする"
  type        = bool
  default     = true
}

variable "bedrock_model_arns" {
  description = "呼んでよいモデル (推論プロファイルと基盤モデル) の ARN。空なら全モデル (*)"
  type        = list(string)
  default     = []
}

variable "code_interpreter_arns" {
  description = "使ってよい Code Interpreter の ARN。空なら全部 (*)"
  type        = list(string)
  default     = []
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

# ---- 利用料金 (任意)。langfuse_secret_arn が空なら作らない ----

variable "langfuse_secret_arn" {
  description = "Langfuse のキーを入れた Secrets Manager のシークレット ARN (JSON: {\"publicKey\": \"pk-lf-...\", \"secretKey\": \"sk-lf-...\"})。空なら利用料金の機能を作らない"
  type        = string
  default     = ""
}

variable "langfuse_host" {
  description = "Lambda から見た Langfuse の URL (EKS 上の Langfuse の前に置いた内部 ALB など)"
  type        = string
  default     = ""
}

variable "lambda_subnet_ids" {
  description = "Lambda を置くサブネット。Langfuse (EKS)、Secrets Manager と DynamoDB (VPC エンドポイントか NAT) に届くこと"
  type        = list(string)
  default     = []
}

variable "lambda_security_group_ids" {
  description = "Lambda のセキュリティグループ"
  type        = list(string)
  default     = []
}

variable "utc_offset_minutes" {
  description = "「今日」「今月」の区切りに使うタイムゾーン (分)。日本は 540"
  type        = number
  default     = 540
}

variable "default_monthly_limit_usd" {
  description = "利用者 1 人あたりの月の利用上限 (USD、Langfuse の推定額)。0 なら上限なし。利用者ごとの上書きは pnpm limits"
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
