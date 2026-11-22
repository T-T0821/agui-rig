terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# 開発用アカウント (state のバケットと権限の上限ポリシーを作る)
provider "aws" {
  region  = var.region
  profile = var.dev_account_profile

  default_tags {
    tags = { Project = "agui-rig", Environment = "dev", ManagedBy = "infra/dev-account" }
  }
}

# IAM Identity Center を管理するアカウント (管理アカウントか委任管理者)。権限セットはここに作る
provider "aws" {
  alias   = "identity_center"
  region  = var.identity_center_region != "" ? var.identity_center_region : var.region
  profile = var.identity_center_profile

  default_tags {
    tags = { Project = "agui-rig", ManagedBy = "infra/dev-account" }
  }
}
