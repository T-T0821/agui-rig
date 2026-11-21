variable "region" {
  description = "開発用アカウントで使うリージョン (開発者の環境と state のバケット)"
  type        = string
  default     = "ap-northeast-1"
}

variable "dev_account_profile" {
  description = "開発用アカウントの管理者の AWS プロファイル。null なら既定の認証"
  type        = string
  default     = null
}

variable "name_prefix" {
  description = "開発者の環境の名前の接頭辞。pnpm dev-env は agui-rig-dev-<名前> で作るので変えない"
  type        = string
  default     = "agui-rig-dev"
}

# ---- Terraform の state ----

variable "state_bucket_name" {
  description = "state を置く S3 バケット名。空なら <name_prefix>-tfstate-<アカウント ID>"
  type        = string
  default     = ""
}

variable "state_noncurrent_days" {
  description = "古い版の state を残す日数"
  type        = number
  default     = 90
}

# ---- IAM Identity Center の権限セット (任意) ----

variable "create_permission_set" {
  description = "開発者用の権限セットを IAM Identity Center に作って割り当てる"
  type        = bool
  default     = true
}

variable "identity_center_profile" {
  description = "IAM Identity Center を管理するアカウント (管理アカウントか委任管理者) の AWS プロファイル。null なら既定の認証"
  type        = string
  default     = null
}

variable "identity_center_region" {
  description = "IAM Identity Center のリージョン。空なら region と同じ"
  type        = string
  default     = ""
}

variable "developer_group_name" {
  description = "権限セットを割り当てる Identity Center のグループの表示名。空なら割り当てない (権限セットだけ作る)"
  type        = string
  default     = ""
}

variable "permission_set_name" {
  description = "権限セットの名前 (aws sso configure で選ぶロール名になる)"
  type        = string
  default     = "AguiRigDeveloper"
}

variable "session_duration" {
  description = "ログインの有効期間 (ISO 8601)"
  type        = string
  default     = "PT8H"
}

variable "allow_bedrock" {
  description = "開発者が自分の認証で Bedrock と Code Interpreter を呼べるようにする (pnpm dev:aws 用)"
  type        = bool
  default     = true
}
