# 開発者用の IAM Identity Center の権限セット。開発者は aws sso login でこの権限で開発用アカウントに入り、
# pnpm dev-env で自分の環境 (agui-rig-dev-<名前>) を作る・消す。できるのは:
#   - agui-rig-dev-* の IAM ロール (権限の上限つきでだけ作れる)
#   - agui-rig-dev-* の Lambda と DynamoDB、API Gateway (REST API)、Cognito
#   - state のバケットの読み書き、Lambda のログの閲覧、タグでの検索
#   - (allow_bedrock) 自分の認証での Bedrock と Code Interpreter (pnpm dev:aws)

locals {
  ps_enabled = var.create_permission_set
  prefix     = var.name_prefix
  acct       = local.account_id

  developer_statements = concat([
    {
      Sid      = "CreateRolesOnlyWithBoundary"
      Effect   = "Allow"
      Action   = ["iam:CreateRole", "iam:PutRolePermissionsBoundary"]
      Resource = "arn:aws:iam::${local.acct}:role/${local.prefix}-*"
      Condition = {
        StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.boundary.arn }
      }
    },
    {
      Sid    = "ManageDevRoles"
      Effect = "Allow"
      Action = [
        "iam:GetRole", "iam:DeleteRole", "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags",
        "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole",
      ]
      Resource = "arn:aws:iam::${local.acct}:role/${local.prefix}-*"
    },
    {
      Sid      = "AttachOnlyLambdaManagedPolicies"
      Effect   = "Allow"
      Action   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
      Resource = "arn:aws:iam::${local.acct}:role/${local.prefix}-*"
      Condition = {
        ArnEquals = {
          "iam:PolicyARN" = [
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
            "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
          ]
        }
      }
    },
    {
      Sid      = "PassDevRolesToLambda"
      Effect   = "Allow"
      Action   = "iam:PassRole"
      Resource = "arn:aws:iam::${local.acct}:role/${local.prefix}-*"
      Condition = {
        StringEquals = { "iam:PassedToService" = "lambda.amazonaws.com" }
      }
    },
    {
      Sid      = "IamRead"
      Effect   = "Allow"
      Action   = ["iam:ListRoles", "iam:GetPolicy", "iam:GetPolicyVersion"]
      Resource = "*"
    },
    {
      Sid      = "NeverRemoveBoundary"
      Effect   = "Deny"
      Action   = ["iam:DeleteRolePermissionsBoundary"]
      Resource = "*"
    },
    {
      Sid    = "DevLambda"
      Effect = "Allow"
      Action = "lambda:*"
      Resource = [
        "arn:aws:lambda:*:${local.acct}:function:${local.prefix}-*",
        "arn:aws:lambda:*:${local.acct}:function:${local.prefix}-*:*",
      ]
    },
    {
      Sid      = "LambdaRead"
      Effect   = "Allow"
      Action   = ["lambda:ListFunctions", "lambda:GetAccountSettings"]
      Resource = "*"
    },
    {
      Sid    = "DevTables"
      Effect = "Allow"
      Action = "dynamodb:*"
      Resource = [
        "arn:aws:dynamodb:*:${local.acct}:table/${local.prefix}-*",
        "arn:aws:dynamodb:*:${local.acct}:table/${local.prefix}-*/*",
      ]
    },
    {
      Sid      = "DynamoDbRead"
      Effect   = "Allow"
      Action   = ["dynamodb:ListTables", "dynamodb:DescribeLimits"]
      Resource = "*"
    },
    {
      # REST API は名前ではなく ID の ARN なので、REST API の範囲で許す
      Sid    = "RestApis"
      Effect = "Allow"
      Action = ["apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE"]
      Resource = [
        "arn:aws:apigateway:*::/restapis",
        "arn:aws:apigateway:*::/restapis/*",
        "arn:aws:apigateway:*::/tags/*",
      ]
    },
    {
      # ユーザープールは作成時の名前で絞れないので、開発用アカウントの Cognito を許す
      Sid      = "Cognito"
      Effect   = "Allow"
      Action   = "cognito-idp:*"
      Resource = "*"
    },
    {
      Sid    = "LambdaLogsRead"
      Effect = "Allow"
      Action = [
        "logs:DescribeLogStreams", "logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartLiveTail",
        "logs:DeleteLogGroup",
      ]
      Resource = "arn:aws:logs:*:${local.acct}:log-group:/aws/lambda/${local.prefix}-*"
    },
    {
      Sid      = "LogsList"
      Effect   = "Allow"
      Action   = ["logs:DescribeLogGroups", "tag:GetResources"]
      Resource = "*"
    },
    {
      Sid      = "StateBucketList"
      Effect   = "Allow"
      Action   = "s3:ListBucket"
      Resource = aws_s3_bucket.state.arn
    },
    {
      Sid      = "StateObjects"
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      Resource = ["${aws_s3_bucket.state.arn}/${local.prefix}/*", "${aws_s3_bucket.state.arn}/agui-rig/*"]
    },
    ], var.allow_bedrock ? [
    {
      Sid      = "Bedrock"
      Effect   = "Allow"
      Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles", "bedrock:GetInferenceProfile"]
      Resource = "*"
    },
    {
      Sid    = "CodeInterpreter"
      Effect = "Allow"
      Action = [
        "bedrock-agentcore:StartCodeInterpreterSession",
        "bedrock-agentcore:InvokeCodeInterpreter",
        "bedrock-agentcore:StopCodeInterpreterSession",
      ]
      Resource = "*"
    },
  ] : [])
}

data "aws_ssoadmin_instances" "this" {
  count    = local.ps_enabled ? 1 : 0
  provider = aws.identity_center
}

locals {
  sso_instance_arn  = local.ps_enabled ? tolist(data.aws_ssoadmin_instances.this[0].arns)[0] : null
  identity_store_id = local.ps_enabled ? tolist(data.aws_ssoadmin_instances.this[0].identity_store_ids)[0] : null
}

resource "aws_ssoadmin_permission_set" "developer" {
  count            = local.ps_enabled ? 1 : 0
  provider         = aws.identity_center
  name             = var.permission_set_name
  description      = "agui-rig: own dev environment (agui-rig-dev-*) via pnpm dev-env"
  instance_arn     = local.sso_instance_arn
  session_duration = var.session_duration
}

resource "aws_ssoadmin_permission_set_inline_policy" "developer" {
  count              = local.ps_enabled ? 1 : 0
  provider           = aws.identity_center
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.developer[0].arn
  inline_policy      = jsonencode({ Version = "2012-10-17", Statement = local.developer_statements })
}

data "aws_identitystore_group" "developers" {
  count             = local.ps_enabled && var.developer_group_name != "" ? 1 : 0
  provider          = aws.identity_center
  identity_store_id = local.identity_store_id

  alternate_identifier {
    unique_attribute {
      attribute_path  = "DisplayName"
      attribute_value = var.developer_group_name
    }
  }
}

# グループに、開発用アカウントでこの権限セットを割り当てる
resource "aws_ssoadmin_account_assignment" "developers" {
  count              = local.ps_enabled && var.developer_group_name != "" ? 1 : 0
  provider           = aws.identity_center
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.developer[0].arn
  principal_type     = "GROUP"
  principal_id       = data.aws_identitystore_group.developers[0].group_id
  target_type        = "AWS_ACCOUNT"
  target_id          = local.account_id

  depends_on = [aws_ssoadmin_permission_set_inline_policy.developer]
}
