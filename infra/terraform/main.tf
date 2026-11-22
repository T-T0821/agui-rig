# バックエンド: アプリ ─(ID トークン)→ API Gateway (REST API 1 本) → Lambda → DynamoDB / Bedrock / AgentCore
#
#   GET /threads、GET|PUT|DELETE /threads/{id}  チャット履歴 (history.mjs)
#   GET /usage                                 利用料金と利用上限 (usage.mjs)
#   POST /v1/chat/completions                  LLM プロキシ: OpenAI 互換 → Bedrock ConverseStream (proxy.mjs、ストリーミング)
#   POST /v1/code-interpreter/{invoke,stop}    Code Interpreter の中継 (proxy.mjs、ストリーミング)
#
# 全ルートを 1 つの Lambda オーソライザー (authorizer.mjs) が守る。ID トークンの署名・iss・aud・期限を確かめ、
# 検証済みの sub を各 Lambda に渡す。アプリ (各 PC) は AWS の認証情報を持たない。
# REST API にしているのは、Lambda の応答をストリーミングで返せるのが REST API だけのため (HTTP API はまとめて返す)。
#
# Lambda のコードは app/backend (TypeScript)。terraform plan の前にビルドする:
#   リポジトリのルートで pnpm install && pnpm backend:build

locals {
  backend_dist = "${path.module}/../../app/backend/dist"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

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

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---- Lambda (zip はビルド済みの app/backend/dist から作る) ----

locals {
  lambda_sources = ["history", "usage", "proxy", "authorizer"]
}

data "archive_file" "lambda" {
  for_each    = toset(local.lambda_sources)
  type        = "zip"
  source_file = "${local.backend_dist}/${each.key}.mjs"
  output_path = "${path.module}/.build/${each.key}.zip"

  lifecycle {
    precondition {
      condition     = fileexists("${local.backend_dist}/${each.key}.mjs")
      error_message = "バックエンドの Lambda がビルドされていません。先に リポジトリのルートで pnpm install && pnpm backend:build を実行してください。"
    }
  }
}

# ---- チャット履歴の Lambda ----

resource "aws_iam_role" "history_function" {
  name                 = "${var.name}-history-function"
  assume_role_policy   = data.aws_iam_policy_document.lambda_trust.json
  permissions_boundary = var.permissions_boundary_arn != "" ? var.permissions_boundary_arn : null
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
  filename         = data.archive_file.lambda["history"].output_path
  source_code_hash = data.archive_file.lambda["history"].output_base64sha256

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.history.name
    }
  }
}

# ---- オーソライザー (ID トークンの検証。全ルートで共用) ----

resource "aws_iam_role" "authorizer_function" {
  name                 = "${var.name}-authorizer-function"
  assume_role_policy   = data.aws_iam_policy_document.lambda_trust.json
  permissions_boundary = var.permissions_boundary_arn != "" ? var.permissions_boundary_arn : null
}

resource "aws_iam_role_policy_attachment" "authorizer_function_logs" {
  role       = aws_iam_role.authorizer_function.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "authorizer" {
  function_name    = "${var.name}-authorizer"
  description      = "ID トークン (Auth0 / Cognito) を JWKS で検証し、sub を API に渡す"
  runtime          = "nodejs22.x"
  handler          = "authorizer.handler"
  timeout          = 10
  memory_size      = 256
  role             = aws_iam_role.authorizer_function.arn
  filename         = data.archive_file.lambda["authorizer"].output_path
  source_code_hash = data.archive_file.lambda["authorizer"].output_base64sha256

  environment {
    variables = {
      OIDC_ISSUER    = local.oidc_issuer
      OIDC_CLIENT_ID = local.oidc_client_id
    }
  }

  lifecycle {
    precondition {
      condition     = local.oidc_issuer != "" && local.oidc_client_id != ""
      error_message = "oidc_issuer と oidc_client_id (Auth0) を指定するか、create_cognito = true にしてください。"
    }
  }
}

# ---- API Gateway (REST API) ----

resource "aws_api_gateway_rest_api" "backend" {
  name        = "${var.name}-backend"
  description = "agui-rig のバックエンド (チャット履歴・利用料金・LLM プロキシ)"

  endpoint_configuration {
    # ストリーミングのアイドルタイムアウトは、リージョン (5 分) のほうがエッジ最適化 (30 秒) より長い
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_authorizer" "id_token" {
  rest_api_id                      = aws_api_gateway_rest_api.backend.id
  name                             = "id-token"
  type                             = "TOKEN"
  authorizer_uri                   = aws_lambda_function.authorizer.invoke_arn
  identity_source                  = "method.request.header.Authorization"
  identity_validation_expression   = "^Bearer [-0-9a-zA-Z._~+/=]+$"
  authorizer_result_ttl_in_seconds = var.authorizer_cache_ttl
}

resource "aws_lambda_permission" "authorizer" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.backend.execution_arn}/authorizers/${aws_api_gateway_authorizer.id_token.id}"
}

# リソース (パス)。親は path_part の前の部分
locals {
  api_paths = {
    "threads"                    = { parent = "", part = "threads" }
    "threads/{id}"               = { parent = "threads", part = "{id}" }
    "usage"                      = { parent = "", part = "usage" }
    "v1"                         = { parent = "", part = "v1" }
    "v1/chat"                    = { parent = "v1", part = "chat" }
    "v1/chat/completions"        = { parent = "v1/chat", part = "completions" }
    "v1/code-interpreter"        = { parent = "v1", part = "code-interpreter" }
    "v1/code-interpreter/invoke" = { parent = "v1/code-interpreter", part = "invoke" }
    "v1/code-interpreter/stop"   = { parent = "v1/code-interpreter", part = "stop" }
  }

  # ルート → Lambda。stream = true はレスポンスストリーミング (InvokeWithResponseStream)
  api_routes = {
    "GET threads"                     = { path = "threads", method = "GET", function = "history", stream = false }
    "GET threads/{id}"                = { path = "threads/{id}", method = "GET", function = "history", stream = false }
    "PUT threads/{id}"                = { path = "threads/{id}", method = "PUT", function = "history", stream = false }
    "DELETE threads/{id}"             = { path = "threads/{id}", method = "DELETE", function = "history", stream = false }
    "GET usage"                       = { path = "usage", method = "GET", function = "usage", stream = false }
    "POST v1/chat/completions"        = { path = "v1/chat/completions", method = "POST", function = "proxy", stream = true }
    "POST v1/code-interpreter/invoke" = { path = "v1/code-interpreter/invoke", method = "POST", function = "proxy", stream = true }
    "POST v1/code-interpreter/stop"   = { path = "v1/code-interpreter/stop", method = "POST", function = "proxy", stream = true }
  }

  route_functions = {
    history = aws_lambda_function.history
    usage   = aws_lambda_function.usage
    proxy   = aws_lambda_function.proxy
  }
}

# 深さごとに作る (親のリソース ID が先に要るため)
resource "aws_api_gateway_resource" "level1" {
  for_each    = { for k, v in local.api_paths : k => v if v.parent == "" }
  rest_api_id = aws_api_gateway_rest_api.backend.id
  parent_id   = aws_api_gateway_rest_api.backend.root_resource_id
  path_part   = each.value.part
}

resource "aws_api_gateway_resource" "level2" {
  for_each    = { for k, v in local.api_paths : k => v if v.parent != "" && length(split("/", k)) == 2 }
  rest_api_id = aws_api_gateway_rest_api.backend.id
  parent_id   = aws_api_gateway_resource.level1[each.value.parent].id
  path_part   = each.value.part
}

resource "aws_api_gateway_resource" "level3" {
  for_each    = { for k, v in local.api_paths : k => v if length(split("/", k)) == 3 }
  rest_api_id = aws_api_gateway_rest_api.backend.id
  parent_id   = aws_api_gateway_resource.level2[each.value.parent].id
  path_part   = each.value.part
}

locals {
  resource_ids = merge(
    { for k, r in aws_api_gateway_resource.level1 : k => r.id },
    { for k, r in aws_api_gateway_resource.level2 : k => r.id },
    { for k, r in aws_api_gateway_resource.level3 : k => r.id },
  )
}

resource "aws_api_gateway_method" "route" {
  for_each      = local.api_routes
  rest_api_id   = aws_api_gateway_rest_api.backend.id
  resource_id   = local.resource_ids[each.value.path]
  http_method   = each.value.method
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.id_token.id
}

resource "aws_api_gateway_integration" "route" {
  for_each                = local.api_routes
  rest_api_id             = aws_api_gateway_rest_api.backend.id
  resource_id             = local.resource_ids[each.value.path]
  http_method             = aws_api_gateway_method.route[each.key].http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  # ストリーミングは InvokeWithResponseStream の URI (API の版 2021-11-15)
  uri = (each.value.stream
    ? "arn:aws:apigateway:${data.aws_region.current.region}:lambda:path/2021-11-15/functions/${local.route_functions[each.value.function].arn}/response-streaming-invocations"
    : local.route_functions[each.value.function].invoke_arn
  )
  response_transfer_mode = each.value.stream ? "STREAM" : "BUFFERED"
  # ストリーミングは最大 15 分 (900 秒) まで流せる。バッファする方は既定の 29 秒
  timeout_milliseconds = each.value.stream ? 900000 : 29000
}

resource "aws_lambda_permission" "route" {
  for_each      = local.route_functions
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.backend.execution_arn}/*/*/*"
}

resource "aws_api_gateway_deployment" "backend" {
  rest_api_id = aws_api_gateway_rest_api.backend.id

  # ルートや統合が変わったら、新しくデプロイし直す
  triggers = {
    redeployment = sha1(jsonencode([
      local.api_paths,
      local.api_routes,
      aws_api_gateway_authorizer.id_token,
      [for m in aws_api_gateway_method.route : m.id],
      [for i in aws_api_gateway_integration.route : [i.id, i.uri, i.response_transfer_mode, i.timeout_milliseconds]],
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_api_gateway_integration.route]
}

resource "aws_api_gateway_stage" "api" {
  rest_api_id   = aws_api_gateway_rest_api.backend.id
  deployment_id = aws_api_gateway_deployment.backend.id
  stage_name    = "api"
}

# スロットリング (全利用者の合計)
resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.backend.id
  stage_name  = aws_api_gateway_stage.api.stage_name
  method_path = "*/*"

  settings {
    throttling_rate_limit  = var.api_throttle_rate
    throttling_burst_limit = var.api_throttle_burst
  }
}

# オーソライザーで断られたときも JSON で返す (アプリが message を表示する)
resource "aws_api_gateway_gateway_response" "unauthorized" {
  rest_api_id   = aws_api_gateway_rest_api.backend.id
  response_type = "UNAUTHORIZED"
  status_code   = "401"

  response_templates = {
    "application/json" = "{\"message\":\"Unauthorized\",\"error\":{\"message\":\"ログインし直してください (ID トークンが無効です)\",\"type\":\"unauthorized\"}}"
  }
}
