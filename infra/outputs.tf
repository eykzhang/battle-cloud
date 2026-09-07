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

output "api_url" {
  description = "The public HTTPS endpoint. This is the thing the project did not have."
  value       = "https://${aws_apprunner_service.api.service_url}"
}

output "worker_cluster" {
  description = "ECS cluster the worker tasks run in."
  value       = aws_ecs_cluster.main.name
}

output "worker_task_definition" {
  description = "Task definition family. The API and the sweep both target the family rather than a revision, so a redeploy is picked up without touching either."
  value       = aws_ecs_task_definition.worker.family
}

output "worker_network" {
  description = "What a RunTask call has to pass, since the task is awsvpc and nothing else supplies these."
  value = {
    subnet_ids       = aws_subnet.public[*].id
    security_group   = aws_security_group.worker.id
    assign_public_ip = true
  }
}

output "database_url_parameters" {
  description = "Set both before the first deploy; Terraform creates them holding a placeholder. `aws ssm put-parameter --name <name> --type SecureString --overwrite --value '<connection string>'`."
  value       = { for tier, parameter in aws_ssm_parameter.database_url : tier => parameter.name }
}
