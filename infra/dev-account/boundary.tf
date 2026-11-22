# 開発者が作る IAM ロールに必ず付ける権限の上限 (permissions boundary)。
# 開発者は agui-rig-dev-* のロールを作ってポリシーを付けられるが、ロールの権限はこの上限を超えない
# (開発者がロール経由で自分の権限を広げることを防ぐ)。pnpm dev-env は .env.cloud の DEV_ENV_PERMISSIONS_BOUNDARY を付ける。

resource "aws_iam_policy" "boundary" {
  name        = "${var.name_prefix}-boundary"
  description = "agui-rig の開発者の環境で作る IAM ロールの権限の上限"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # LLM プロキシの Lambda: Bedrock と AgentCore Code Interpreter
        Sid      = "ProxyBedrock"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = "*"
      },
      {
        Sid    = "ProxyCodeInterpreter"
        Effect = "Allow"
        Action = [
          "bedrock-agentcore:StartCodeInterpreterSession",
          "bedrock-agentcore:InvokeCodeInterpreter",
          "bedrock-agentcore:GetCodeInterpreterSession",
          "bedrock-agentcore:StopCodeInterpreterSession",
        ]
        Resource = "*"
      },
      {
        # Lambda: 自分の環境のテーブルだけ
        Sid      = "LambdaTables"
        Effect   = "Allow"
        Action   = ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource = "arn:aws:dynamodb:*:${local.account_id}:table/${var.name_prefix}-*"
      },
      {
        Sid      = "LambdaLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"
      },
    ]
  })
}
