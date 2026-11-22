# バックエンド: アプリ ─(ID トークン)→ API Gateway (HTTP API + JWT オーソライザー) → Lambda → DynamoDB
# Lambda のコードは app/backend (TypeScript)。terraform plan の前にビルドする:
#   リポジトリのルートで pnpm install && pnpm backend:build
# Lambda はオーソライザーが検証した ID トークンの sub だけで利用者を分ける。

locals {
  backend_dist = "${path.module}/../../app/backend/dist"
}

# pk = 利用者の sub、sk = 会話 ID。会話 1 件 = 1 項目 (メッセージは gzip + base64 で 1 属性に)
resource "aws_dynamodb_table" "history" {
  name         = var.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  server_side_encryption {
    enabled = true
  }
}

# ---- API Gateway ----

resource "aws_apigatewayv2_api" "backend" {
  name          = "${var.name}-backend"
  protocol_type = "HTTP"
  description   = "agui-rig のバックエンド (チャット履歴・利用料金)"
}

# ID トークン (Auth0 / Cognito) を検証する (署名・iss・aud・有効期限)。JWKS は issuer の discovery から自動で引く。
# Lambda には検証済みのクレームが渡る。HTTP API の JWT オーソライザーは Cognito の token_use を見ず、
# Cognito のアクセストークン (client_id = audience) も通すので、Lambda 側 (app/backend/src/http.ts の subOf) で
# token_use が "id" 以外のトークンを 401 にしている
resource "aws_apigatewayv2_authorizer" "id_token" {
  api_id           = aws_apigatewayv2_api.backend.id
  name             = "id-token"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = local.oidc_issuer
    audience = [local.oidc_client_id]
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.backend.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = var.api_throttle_rate
    throttling_burst_limit = var.api_throttle_burst
  }
}

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---- チャット履歴の Lambda ----

data "archive_file" "history" {
  type        = "zip"
  source_file = "${local.backend_dist}/history.mjs"
  output_path = "${path.module}/.build/history.zip"

  lifecycle {
    precondition {
      condition     = fileexists("${local.backend_dist}/history.mjs")
      error_message = "バックエンドの Lambda がビルドされていません。先に リポジトリのルートで pnpm install && pnpm backend:build を実行してください。"
    }
  }
}

resource "aws_iam_role" "history_function" {
  name               = "${var.name}-history-function"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role_policy_attachment" "history_function_logs" {
  role       = aws_iam_role.history_function.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "history_function_table" {
  name = "chat-history-table"
  role = aws_iam_role.history_function.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
      Resource = aws_dynamodb_table.history.arn
    }]
  })
}

resource "aws_lambda_function" "history" {
  function_name    = "${var.name}-history"
  description      = "チャット履歴 (呼び出した利用者 sub の会話だけを読み書きする)"
  runtime          = "nodejs22.x"
  handler          = "history.handler"
  timeout          = 10
  memory_size      = 256
  role             = aws_iam_role.history_function.arn
  filename         = data.archive_file.history.output_path
  source_code_hash = data.archive_file.history.output_base64sha256

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.history.name
    }
  }
}

resource "aws_apigatewayv2_integration" "history" {
  api_id                 = aws_apigatewayv2_api.backend.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.history.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "history" {
  for_each           = toset(["GET /threads", "GET /threads/{id}", "PUT /threads/{id}", "DELETE /threads/{id}"])
  api_id             = aws_apigatewayv2_api.backend.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.history.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.id_token.id
}

resource "aws_lambda_permission" "history" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.history.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.backend.execution_arn}/*/*/threads*"
}
