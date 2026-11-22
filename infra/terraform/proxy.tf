# LLM プロキシ: API Gateway (POST /v1/..., レスポンスストリーミング) → Lambda → Bedrock ConverseStream / AgentCore Code Interpreter
# アプリは AWS の認証情報を持たず、ID トークンでこの API を呼ぶ。Bedrock と Code Interpreter を呼べるのはこの Lambda のロールだけ。
#   - 呼べるモデル: model_prices のキー (料金が分かるモデルだけ)。IAM でも bedrock_model_arns で絞れる
#   - 出力トークンの上限: max_output_tokens
#   - 利用上限: 呼ぶ前に台帳で確かめて 429、呼んだ後に Bedrock のトークン数から料金を足す (usage.tf)
#   - ログ: 呼び出しごとに sub・モデル・トークン数・料金・所要時間を CloudWatch Logs に 1 行の JSON で出す (本文は出さない)

resource "aws_iam_role" "proxy_function" {
  name                 = "${var.name}-proxy-function"
  assume_role_policy   = data.aws_iam_policy_document.lambda_trust.json
  permissions_boundary = var.permissions_boundary_arn != "" ? var.permissions_boundary_arn : null
}

resource "aws_iam_role_policy_attachment" "proxy_function_logs" {
  role       = aws_iam_role.proxy_function.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "proxy_function" {
  statement {
    sid = "Bedrock"
    # Converse は InvokeModel、ConverseStream は InvokeModelWithResponseStream の権限で呼べる
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = length(var.bedrock_model_arns) > 0 ? var.bedrock_model_arns : ["*"]
  }

  statement {
    sid = "CodeInterpreter"
    actions = [
      "bedrock-agentcore:StartCodeInterpreterSession",
      "bedrock-agentcore:InvokeCodeInterpreter",
      "bedrock-agentcore:GetCodeInterpreterSession",
      "bedrock-agentcore:StopCodeInterpreterSession",
    ]
    resources = length(var.code_interpreter_arns) > 0 ? var.code_interpreter_arns : ["*"]
  }

  statement {
    sid       = "UsageLedger"
    actions   = ["dynamodb:BatchGetItem", "dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.usage.arn]
  }

  statement {
    sid       = "UsageLimits"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.limits.arn]
  }
}

resource "aws_iam_role_policy" "proxy_function" {
  name   = "bedrock-code-interpreter-usage"
  role   = aws_iam_role.proxy_function.id
  policy = data.aws_iam_policy_document.proxy_function.json
}

resource "aws_lambda_function" "proxy" {
  function_name = "${var.name}-proxy"
  description   = "LLM プロキシ (OpenAI 互換 → Bedrock ConverseStream) と Code Interpreter の中継。利用上限と料金の記録もここで行う"
  runtime       = "nodejs22.x"
  handler       = "proxy.handler"
  # API Gateway のストリーミングは最大 15 分
  timeout          = 900
  memory_size      = 512
  role             = aws_iam_role.proxy_function.arn
  filename         = data.archive_file.lambda["proxy"].output_path
  source_code_hash = data.archive_file.lambda["proxy"].output_base64sha256
  # 同時に動く数の上限 (全利用者の合計)。-1 なら設定しない (アカウントの上限まで)
  reserved_concurrent_executions = var.proxy_reserved_concurrency

  environment {
    variables = merge(local.usage_env, {
      MODEL_PRICES        = jsonencode(var.model_prices)
      MAX_OUTPUT_TOKENS   = tostring(var.max_output_tokens)
      CODE_INTERPRETER_ID = var.code_interpreter_id
    })
  }

  lifecycle {
    precondition {
      condition     = length(var.model_prices) > 0
      error_message = "model_prices に使うモデルと単価を 1 つ以上書いてください (載っていないモデルはプロキシで呼べません)。"
    }
  }
}
