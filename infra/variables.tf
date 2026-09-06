variable "aws_region" {
  description = "Region for every resource here. ECR is regional, and a deploy pulls from the registry in its own region, so this has to match wherever the worker tasks end up running."
  type        = string
  default     = "us-east-1"
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
