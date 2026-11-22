# 利用料金と利用上限: API Gateway (GET /usage) → Lambda → DynamoDB
#   台帳 (usage テーブル): LLM プロキシがモデル呼び出しのたびに、Bedrock が返したトークン数 × model_prices の料金を足す。
#     pk = sub、sk = "M#2026-11" (月) / "D#2026-11-22" (日、100 日で TTL)。区切りは utc_offset_minutes のタイムゾーン
#   上限 (usage-limits テーブル): pk = sub。管理者がルートの `pnpm limits` で monthlyLimitUsd と手動リセットを書く。
#     /usage のたびに Lambda が利用者名と最新の料金を書く (管理者の一覧用)
# 上限は毎月の月初に自動で戻る (台帳が月ごとに分かれているため)。上限の判定はプロキシ (サーバー側) が行うので、
# アプリを改造しても迂回できない。

resource "aws_dynamodb_table" "usage" {
  name         = "${var.name}-usage"
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

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  server_side_encryption {
    enabled = true
  }
}

# pk = 利用者の sub。管理者: monthlyLimitUsd (0 = 上限なし)、resetAt / resetBaseUsd (手動リセット)
# Lambda: userName、lastSeenAt、monthUsd、periodUsd、limitUsd、blocked
resource "aws_dynamodb_table" "limits" {
  name         = "${var.name}-usage-limits"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  server_side_encryption {
    enabled = true
  }
}

locals {
  # 利用料金を読む Lambda (usage と proxy) に共通の設定
  usage_env = {
    USAGE_TABLE               = aws_dynamodb_table.usage.name
    LIMITS_TABLE              = aws_dynamodb_table.limits.name
    UTC_OFFSET_MINUTES        = tostring(var.utc_offset_minutes)
    DEFAULT_MONTHLY_LIMIT_USD = tostring(var.default_monthly_limit_usd)
    LIMIT_WARN_RATIO          = tostring(var.limit_warn_ratio)
  }
}

resource "aws_iam_role" "usage_function" {
  name                 = "${var.name}-usage-function"
  assume_role_policy   = data.aws_iam_policy_document.lambda_trust.json
  permissions_boundary = var.permissions_boundary_arn != "" ? var.permissions_boundary_arn : null
}

resource "aws_iam_role_policy_attachment" "usage_function_logs" {
  role       = aws_iam_role.usage_function.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "usage_function_tables" {
  name = "usage-tables"
  role = aws_iam_role.usage_function.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:BatchGetItem", "dynamodb:GetItem"]
        Resource = aws_dynamodb_table.usage.arn
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.limits.arn
      },
    ]
  })
}

resource "aws_lambda_function" "usage" {
  function_name    = "${var.name}-usage"
  description      = "呼び出した利用者 (sub) の今日と今月の料金と利用上限の状態を、台帳から返す"
  runtime          = "nodejs22.x"
  handler          = "usage.handler"
  timeout          = 10
  memory_size      = 256
  role             = aws_iam_role.usage_function.arn
  filename         = data.archive_file.lambda["usage"].output_path
  source_code_hash = data.archive_file.lambda["usage"].output_base64sha256

  environment {
    variables = local.usage_env
  }
}
