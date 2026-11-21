# 開発用のログイン (任意): Cognito のユーザープール。create_cognito = true のときだけ作る。
# Auth0 と同じく OpenID Connect の ID トークンを出すので、STS、API Gateway の JWT オーソライザー、Collector はそのまま使える。
#   issuer = https://cognito-idp.<リージョン>.amazonaws.com/<プール ID> (末尾に / は付かない)、aud = アプリクライアント ID
# 利用者は管理者が作る (自分でサインアップはできない): aws cognito-idp admin-create-user ...

locals {
  oidc_issuer    = var.create_cognito ? "https://${aws_cognito_user_pool.dev[0].endpoint}" : var.oidc_issuer
  oidc_client_id = var.create_cognito ? aws_cognito_user_pool_client.desktop[0].id : var.oidc_client_id
}

resource "aws_cognito_user_pool" "dev" {
  count                    = var.create_cognito ? 1 : 0
  name                     = "${var.name}-dev"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  lifecycle {
    precondition {
      condition     = var.oidc_issuer == "" && var.oidc_client_id == ""
      error_message = "create_cognito = true のときは oidc_issuer と oidc_client_id を空にしてください (Cognito の値を使います)。"
    }
  }
}

# ログイン画面 (Cognito のホストされた UI) のドメイン
resource "aws_cognito_user_pool_domain" "dev" {
  count        = var.create_cognito ? 1 : 0
  domain       = var.cognito_domain_prefix != "" ? var.cognito_domain_prefix : "${var.name}-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.dev[0].id
}

# デスクトップアプリ用のパブリッククライアント (シークレットなし、Authorization Code + PKCE)
resource "aws_cognito_user_pool_client" "desktop" {
  count        = var.create_cognito ? 1 : 0
  name         = "${var.name}-desktop"
  user_pool_id = aws_cognito_user_pool.dev[0].id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  # Cognito は http なら localhost しか許さない。アプリは issuer が Cognito なら自動で localhost を使う
  callback_urls       = ["http://localhost:${var.cognito_callback_port}/callback"]
  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]

  # ID トークンは 1 時間 (アプリが期限前にリフレッシュする)。リフレッシュトークンは 30 日
  id_token_validity      = 60
  access_token_validity  = 60
  refresh_token_validity = 30

  token_validity_units {
    id_token      = "minutes"
    access_token  = "minutes"
    refresh_token = "days"
  }

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
}
