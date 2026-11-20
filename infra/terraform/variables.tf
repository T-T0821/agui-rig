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

# ---- Auth0 ----

variable "oidc_issuer" {
  description = "Auth0 の issuer (例 https://your-tenant.auth0.com/)。ID トークンの iss と末尾の / まで完全に一致させる"
  type        = string

  validation {
    condition     = startswith(var.oidc_issuer, "https://")
    error_message = "oidc_issuer は https:// で始めてください。"
  }
}

variable "oidc_client_id" {
  description = "Auth0 の Client ID (ID トークンの aud)"
  type        = string
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
  description = "Lambda を置くサブネット。Langfuse (EKS) と Secrets Manager (VPC エンドポイントか NAT) に届くこと"
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
