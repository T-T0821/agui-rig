output "chat_api_url" {
  description = "アプリの CHAT_API_URL に設定する (API Gateway の URL)"
  value       = aws_apigatewayv2_api.backend.api_endpoint
}

output "app_role_arn" {
  description = "アプリの AWS_ROLE_ARN に設定する"
  value       = aws_iam_role.app.arn
}

output "table_name" {
  value = aws_dynamodb_table.history.name
}

output "usage_enabled" {
  description = "利用料金の機能を作ったか"
  value       = local.usage_enabled
}

output "limits_table_name" {
  description = "利用上限のテーブル (app/backend の npm run limits の LIMITS_TABLE)。利用料金を作らなければ null"
  value       = local.usage_enabled ? aws_dynamodb_table.limits[0].name : null
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
