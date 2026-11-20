# チャット履歴: アプリ ─(ID トークン)→ AppSync (OpenID Connect 認証) → DynamoDB
# リゾルバーは AppSync が検証した ID トークンの sub (ctx.identity.sub) だけで利用者を分ける。

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
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

resource "aws_appsync_graphql_api" "chat" {
  name                = "${var.name}-chat-history"
  authentication_type = "OPENID_CONNECT"
  schema              = file("${path.module}/schema.graphql")

  openid_connect_config {
    issuer    = var.oidc_issuer
    client_id = var.oidc_client_id
    auth_ttl  = 3600000
    iat_ttl   = 3600000
  }
}

data "aws_iam_policy_document" "appsync_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["appsync.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "history_datasource" {
  name               = "${var.name}-appsync-history"
  assume_role_policy = data.aws_iam_policy_document.appsync_trust.json
}

resource "aws_iam_role_policy" "history_datasource" {
  name = "chat-history-table"
  role = aws_iam_role.history_datasource.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
      Resource = aws_dynamodb_table.history.arn
    }]
  })
}

resource "aws_appsync_datasource" "history" {
  api_id           = aws_appsync_graphql_api.chat.id
  name             = "ChatHistoryTable"
  type             = "AMAZON_DYNAMODB"
  service_role_arn = aws_iam_role.history_datasource.arn

  dynamodb_config {
    table_name = aws_dynamodb_table.history.name
    region     = var.region
  }
}

# 引数で利用者を指定する方法は無いので、他人の会話には届かない
locals {
  history_resolvers = {
    threads       = { type = "Query", field = "threads" }
    thread        = { type = "Query", field = "thread" }
    save_thread   = { type = "Mutation", field = "saveThread" }
    delete_thread = { type = "Mutation", field = "deleteThread" }
  }
}

resource "aws_appsync_resolver" "history" {
  for_each    = local.history_resolvers
  api_id      = aws_appsync_graphql_api.chat.id
  type        = each.value.type
  field       = each.value.field
  data_source = aws_appsync_datasource.history.name
  code        = file("${path.module}/resolvers/${each.key}.js")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}
