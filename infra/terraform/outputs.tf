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
