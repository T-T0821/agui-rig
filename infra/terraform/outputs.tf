output "region" {
  description = "アプリの AWS_REGION に設定する"
  value       = var.region
}

output "chat_api_url" {
  description = "アプリの CHAT_API_URL に設定する (API Gateway の URL。チャット履歴・利用料金・LLM プロキシ /v1 の共通の入口)"
  value       = aws_api_gateway_stage.api.invoke_url
}

output "allowed_models" {
  description = "プロキシで呼べるモデル (アプリの BEDROCK_MODEL_ID はこのどれか)"
  value       = keys(var.model_prices)
}

output "table_name" {
  value = aws_dynamodb_table.history.name
}

output "limits_table_name" {
  description = "利用上限のテーブル (pnpm limits の LIMITS_TABLE)"
  value       = aws_dynamodb_table.limits.name
}

output "usage_table_name" {
  description = "利用料金の台帳 (pnpm limits reset の USAGE_TABLE)"
  value       = aws_dynamodb_table.usage.name
}

output "oauth_issuer" {
  description = "アプリの OAUTH_ISSUER に設定する (Auth0 なら入力した値、Cognito ならユーザープールの issuer)"
  value       = local.oidc_issuer
}

output "oauth_client_id" {
  description = "アプリの OAUTH_CLIENT_ID に設定する"
  value       = local.oidc_client_id
}

output "cognito_login_url" {
  description = "Cognito のログイン画面のドメイン (create_cognito = true のとき)"
  value       = var.create_cognito ? "https://${aws_cognito_user_pool_domain.dev[0].domain}.auth.${var.region}.amazoncognito.com" : null
}

output "cognito_user_pool_id" {
  description = "利用者を作るときに使う (aws cognito-idp admin-create-user --user-pool-id ...)"
  value       = var.create_cognito ? aws_cognito_user_pool.dev[0].id : null
}
