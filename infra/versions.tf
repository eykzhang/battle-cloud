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

  # State is local, deliberately, and this is the first thing to revisit.
  #
  # An S3 backend needs a bucket, and creating that bucket with the same Terraform whose
  # state it holds is the usual bootstrap knot. Local state is honest for a single
  # operator applying from one machine: it is lost if the machine is, and it cannot be
  # applied from two places at once. Neither is true yet.
  #
  # When it moves: S3 with `use_lockfile = true`, which is native S3 conditional-write
  # locking and needs no DynamoDB table.
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
