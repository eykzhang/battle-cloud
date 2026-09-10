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

variable "worker_image_tag" {
  description = "The ECR tag the worker task definition runs. Usually the commit the API was deployed from, and it does not have to be: the analysis identity, not the deploy, is what decides whether two workers are interchangeable."
  type        = string
  default     = "e6385f8be6a722266345d76cb149a23e9edbc349"
}

variable "poke_engine_tag" {
  description = "The poke-engine tag the worker image was built from. An identity field the API stamps onto jobs. A value that disagrees with the worker image costs cache misses rather than correctness."
  type        = string
  default     = "v0.0.48"
}

variable "usage_stats_dataset" {
  description = "The month of the usage-stats file the worker image carries. An identity field with a sharper failure mode than the tag: a worker claims only jobs naming its own dataset, so a wrong value here leaves every submission queued while both tiers report healthy."
  type        = string
  default     = "2026-07"
}

variable "worker_max_concurrent_tasks" {
  description = "Ceiling on worker tasks the API will start. A burst of submissions should not become a task per submission: each drains the whole queue, so a second task earns its cost only when the first cannot keep up."
  type        = number
  default     = 2
}

variable "sweep_interval_minutes" {
  description = "How often the scheduled sweep runs a worker regardless of any trigger. Every execution bills a one-minute Fargate minimum at about $0.0033 whether or not it finds work, so this is a cost dial as much as a latency one. See the arithmetic in scheduler.tf."
  type        = number
  default     = 60
}
