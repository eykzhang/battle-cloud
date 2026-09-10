terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # State lives in the bucket `state.tf` creates.
  #
  # The bootstrap was a forced two-step, which is why this reads circularly: a backend
  # cannot reference a bucket a later run creates, so the bucket was applied under local
  # state and this block adopted it afterwards. The local `terraform.tfstate` is still on
  # disk as a backup and is no longer read.
  #
  # Locking is `use_lockfile = true`, S3 native conditional writes. The DynamoDB table that
  # used to be mandatory for locking is not needed and is not here.
  #
  backend "s3" {
    bucket       = "battle-cloud-tfstate-618426070248"
    key          = "infra/terraform.tfstate"
    region       = "us-east-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "battle-cloud"
      ManagedBy = "terraform"
    }
  }
}
