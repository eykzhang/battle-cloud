data "aws_caller_identity" "current" {}

output "ecr_registry" {
  description = "Set this as the ECR_REGISTRY repository variable in GitHub."
  value       = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
}

output "github_actions_role_arn" {
  description = "Set this as the AWS_ROLE_ARN repository variable in GitHub. The mirror job stays skipped until it exists."
  value       = aws_iam_role.github_actions.arn
}

output "repository_urls" {
  description = "One per image."
  value       = { for name, repository in aws_ecr_repository.image : name => repository.repository_url }
}
