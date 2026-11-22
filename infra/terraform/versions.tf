terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # 6.26 以上: API Gateway の統合の response_transfer_mode (レスポンスストリーミング)
      version = ">= 6.26, < 7.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = var.region

  # 開発者ごとの環境の消し忘れを Owner / Environment タグで探せるようにする
  default_tags {
    tags = merge(
      { Project = "agui-rig", Environment = var.environment },
      var.owner != "" ? { Owner = var.owner } : {},
    )
  }
}
