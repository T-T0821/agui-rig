terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
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
