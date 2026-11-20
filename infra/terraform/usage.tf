# 利用料金 (任意): API Gateway (GET /usage) → Lambda (VPC 内) → Langfuse の集計 API
# Langfuse のキーは Secrets Manager にあり、この Lambda だけが読む (アプリには渡さない)。
# Lambda はオーソライザーが検証した sub の金額だけを返す。作らなければ /usage は 404 になり、アプリは料金を出さない。

locals {
  usage_enabled = var.langfuse_secret_arn != ""
}

data "archive_file" "usage" {
  count       = local.usage_enabled ? 1 : 0
  type        = "zip"
  source_file = "${local.backend_dist}/usage.mjs"
  output_path = "${path.module}/.build/usage.zip"

  lifecycle {
    precondition {
      condition     = fileexists("${local.backend_dist}/usage.mjs")
      error_message = "バックエンドの Lambda がビルドされていません。先に npm --prefix ../../app/backend ci && npm --prefix ../../app/backend run build を実行してください。"
    }
  }
}

resource "aws_iam_role" "usage_function" {
  count              = local.usage_enabled ? 1 : 0
  name               = "${var.name}-usage-function"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role_policy_attachment" "usage_function_vpc" {
  count      = local.usage_enabled ? 1 : 0
  role       = aws_iam_role.usage_function[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "usage_function_secret" {
  count = local.usage_enabled ? 1 : 0
  name  = "langfuse-secret"
  role  = aws_iam_role.usage_function[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = var.langfuse_secret_arn
    }]
  })
}

resource "aws_lambda_function" "usage" {
  count            = local.usage_enabled ? 1 : 0
  function_name    = "${var.name}-usage"
  description      = "Langfuse から、呼び出した利用者 (sub) の今日と今月の料金を返す"
  runtime          = "nodejs22.x"
  handler          = "usage.handler"
  timeout          = 15
  memory_size      = 256
  role             = aws_iam_role.usage_function[0].arn
  filename         = data.archive_file.usage[0].output_path
  source_code_hash = data.archive_file.usage[0].output_base64sha256

  vpc_config {
    subnet_ids         = var.lambda_subnet_ids
    security_group_ids = var.lambda_security_group_ids
  }

  environment {
    variables = {
      LANGFUSE_HOST       = var.langfuse_host
      LANGFUSE_SECRET_ARN = var.langfuse_secret_arn
      UTC_OFFSET_MINUTES  = tostring(var.utc_offset_minutes)
    }
  }

  # VPC の権限が付いてから作る (ENI を作れずに失敗しないように)
  depends_on = [aws_iam_role_policy_attachment.usage_function_vpc]

  lifecycle {
    precondition {
      condition     = var.langfuse_host != "" && length(var.lambda_subnet_ids) > 0 && length(var.lambda_security_group_ids) > 0
      error_message = "利用料金を作るときは langfuse_host、lambda_subnet_ids、lambda_security_group_ids も指定してください。"
    }
  }
}

resource "aws_apigatewayv2_integration" "usage" {
  count                  = local.usage_enabled ? 1 : 0
  api_id                 = aws_apigatewayv2_api.backend.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.usage[0].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "usage" {
  count              = local.usage_enabled ? 1 : 0
  api_id             = aws_apigatewayv2_api.backend.id
  route_key          = "GET /usage"
  target             = "integrations/${aws_apigatewayv2_integration.usage[0].id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.id_token.id
}

resource "aws_lambda_permission" "usage" {
  count         = local.usage_enabled ? 1 : 0
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.usage[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.backend.execution_arn}/*/GET/usage"
}
