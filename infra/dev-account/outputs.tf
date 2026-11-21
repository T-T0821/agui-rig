output "state_bucket" {
  description = ".env.cloud の DEV_ENV_STATE_BUCKET"
  value       = aws_s3_bucket.state.bucket
}

output "permissions_boundary_arn" {
  description = ".env.cloud の DEV_ENV_PERMISSIONS_BOUNDARY"
  value       = aws_iam_policy.boundary.arn
}

output "permission_set_name" {
  description = "開発者が aws sso configure で選ぶロール名"
  value       = local.ps_enabled ? aws_ssoadmin_permission_set.developer[0].name : null
}

output "dev_account_id" {
  value = local.account_id
}

output "env_cloud" {
  description = "チームの .env.cloud.example に書く値"
  value       = <<-EOT
    DEV_ENV_STATE_BUCKET=${aws_s3_bucket.state.bucket}
    DEV_ENV_STATE_REGION=${var.region}
    DEV_ENV_PERMISSIONS_BOUNDARY=${aws_iam_policy.boundary.arn}
  EOT
}
