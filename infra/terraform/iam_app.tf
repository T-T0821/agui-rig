# アプリ (各 PC の Rust) が ID トークンで引き受けるロール。
# STS の AssumeRoleWithWebIdentity で一時認証情報に替え、Bedrock と AgentCore Code Interpreter を呼ぶ。
# DynamoDB の権限は持たせない (チャット履歴は API Gateway 経由)。

locals {
  # IAM の条件キーは issuer から https:// を除いたもの。Auth0 は末尾に / が付くので、キーも "<テナント>.auth0.com/:aud" になる
  oidc_host = trimprefix(local.oidc_issuer, "https://")
}

data "tls_certificate" "issuer" {
  count = var.create_oidc_provider ? 1 : 0
  url   = local.oidc_issuer
}

# トークンの iss と同じ文字列で登録する (Auth0 は末尾の / まで含める。Cognito は / が付かない)
resource "aws_iam_openid_connect_provider" "issuer" {
  count           = var.create_oidc_provider ? 1 : 0
  url             = local.oidc_issuer
  client_id_list  = [local.oidc_client_id]
  thumbprint_list = [data.tls_certificate.issuer[0].certificates[length(data.tls_certificate.issuer[0].certificates) - 1].sha1_fingerprint]
}

data "aws_caller_identity" "current" {}

locals {
  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.issuer[0].arn : "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/${local.oidc_host}"
}

data "aws_iam_policy_document" "app_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = [local.oidc_client_id]
    }
  }
}

resource "aws_iam_role" "app" {
  name                 = "${var.name}-app"
  description          = "agui-rig のアプリが ID トークン (Auth0 / Cognito) で引き受けるロール"
  assume_role_policy   = data.aws_iam_policy_document.app_trust.json
  max_session_duration = 3600

  lifecycle {
    precondition {
      condition     = local.oidc_issuer != "" && local.oidc_client_id != ""
      error_message = "oidc_issuer と oidc_client_id (Auth0) を指定するか、create_cognito = true にしてください。"
    }
  }
}

data "aws_iam_policy_document" "app" {
  statement {
    sid       = "Bedrock"
    actions   = ["bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModel"]
    resources = length(var.bedrock_model_arns) > 0 ? var.bedrock_model_arns : ["*"]
  }

  statement {
    sid = "CodeInterpreter"
    actions = [
      "bedrock-agentcore:StartCodeInterpreterSession",
      "bedrock-agentcore:InvokeCodeInterpreter",
      "bedrock-agentcore:StopCodeInterpreterSession",
    ]
    resources = length(var.code_interpreter_arns) > 0 ? var.code_interpreter_arns : ["*"]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "bedrock-and-code-interpreter"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}
