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

  # State is local until the bucket in state.tf exists, then it moves here.
  #
  # The two-step is forced: a backend cannot reference a bucket that a later run creates.
  # So `terraform apply` once with local state to create it, then uncomment the block below
  # and run `terraform init -migrate-state`, which copies the existing state up and leaves
  # the local file behind as a backup.
  #
  # Locking is `use_lockfile = true`, S3 native conditional writes. The DynamoDB table that
  # used to be mandatory for locking is not needed and is not here.
  #
  # backend "s3" {
  #   bucket       = "battle-cloud-tfstate-618426070248"
  #   key          = "infra/terraform.tfstate"
  #   region       = "us-east-2"
  #   encrypt      = true
  #   use_lockfile = true
  # }
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
