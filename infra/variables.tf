variable "aws_region" {
  description = "Region for every resource here. ECR is regional, and a deploy pulls from the registry in its own region, so this has to match wherever the worker tasks end up running."
  type        = string
  default     = "us-east-2"
}

variable "github_repository" {
  description = "owner/repo allowed to assume the CI role."
  type        = string
  default     = "eykzhang/battle-cloud"
}

variable "deploy_branch" {
  description = "The only branch whose workflow runs may assume the CI role. Images publish from this branch alone, so the trust policy names it exactly rather than matching a pattern."
  type        = string
  default     = "main"
}

variable "image_retention_count" {
  description = "Tagged images kept per repository before the oldest are expired. Every image is tagged with a commit sha and deploys pin digests, so this is a rollback window measured in deploys."
  type        = number
  default     = 10
}

variable "github_owner_id" {
  description = "GitHub's immutable numeric id for the repository owner. Part of the OIDC subject a workflow run presents, and it does not change when the account is renamed. Read it with `gh api repos/<owner>/<repo> --jq .owner.id`."
  type        = number
  default     = 214009084
}

variable "github_repository_id" {
  description = "GitHub's immutable numeric id for the repository itself, the second half of the OIDC subject. Read it with `gh api repos/<owner>/<repo> --jq .id`."
  type        = number
  default     = 1359218725
}
