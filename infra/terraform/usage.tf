# 利用料金 (任意): AppSync → Lambda (VPC 内) → Langfuse の集計 API
# Langfuse のキーは Secrets Manager にあり、この Lambda だけが読む (アプリには渡さない)。
# Lambda には AppSync が検証した sub だけが渡るので、本人の金額しか返らない。

locals {
  usage_enabled = var.langfuse_secret_arn != ""
}

# Lambda のコードは TypeScript (lambda/usage/src/index.ts)。
# terraform plan の前に `npm --prefix lambda/usage ci && npm --prefix lambda/usage run build` で dist/index.mjs を作る。
data "archive_file" "usage" {
  count       = local.usage_enabled ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/lambda/usage/dist/index.mjs"
  output_path = "${path.module}/.build/usage.zip"

  lifecycle {
    precondition {
      condition     = fileexists("${path.module}/lambda/usage/dist/index.mjs")
      error_message = "利用料金の Lambda がビルドされていません。先に npm --prefix lambda/usage ci && npm --prefix lambda/usage run build を実行してください。"
    }
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
  handler          = "index.handler"
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

resource "aws_iam_role" "usage_datasource" {
  count              = local.usage_enabled ? 1 : 0
  name               = "${var.name}-appsync-usage"
  assume_role_policy = data.aws_iam_policy_document.appsync_trust.json
}

resource "aws_iam_role_policy" "usage_datasource" {
  count = local.usage_enabled ? 1 : 0
  name  = "invoke-usage-function"
  role  = aws_iam_role.usage_datasource[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.usage[0].arn
    }]
  })
}

resource "aws_appsync_datasource" "usage" {
  count            = local.usage_enabled ? 1 : 0
  api_id           = aws_appsync_graphql_api.chat.id
  name             = "LangfuseUsage"
  type             = "AWS_LAMBDA"
  service_role_arn = aws_iam_role.usage_datasource[0].arn

  lambda_config {
    function_arn = aws_lambda_function.usage[0].arn
  }
}

resource "aws_appsync_resolver" "usage" {
  count       = local.usage_enabled ? 1 : 0
  api_id      = aws_appsync_graphql_api.chat.id
  type        = "Query"
  field       = "usage"
  data_source = aws_appsync_datasource.usage[0].name
  code        = file("${path.module}/resolvers/usage.js")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}
