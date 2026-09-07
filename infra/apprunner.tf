# The API, on App Runner, outside any VPC of ours.
#
# App Runner is the cheapest way to get HTTPS, a hostname, and scale-down without paying
# for a load balancer, at roughly $5 to $8 a month. Fargate behind an ALB would be about
# $16 a month for the ALB alone, because a task's public IP changes on every restart and
# something has to terminate TLS at a stable name.
#
# It stays out of a VPC on purpose. A VPC connector would route the service's outbound
# traffic through that VPC, and its calls to replay.pokemonshowdown.com would then need a
# NAT gateway at about $32 a month. Nothing the API talks to is inside a VPC: Postgres is
# Neon, and ECS RunTask is a public AWS API.

# App Runner pulls from a private ECR repository as itself, so it needs a role it can
# assume for that, distinct from the role the running service uses.
resource "aws_iam_role" "apprunner_ecr_access" {
  name = "battle-cloud-apprunner-ecr"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "build.apprunner.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "apprunner_ecr_access" {
  role       = aws_iam_role.apprunner_ecr_access.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

# The role the API process runs as.
resource "aws_iam_role" "apprunner_instance" {
  name = "battle-cloud-apprunner-instance"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "tasks.apprunner.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "apprunner_instance" {
  name = "start-workers-and-read-config"
  role = aws_iam_role.apprunner_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Unlike ECS, App Runner injects secrets using the instance role rather than a
        # separate execution role, so this read belongs to the running service.
        Sid      = "ReadDatabaseUrl"
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = [aws_ssm_parameter.database_url["api"].arn]
      },
      {
        # Every revision of this one family, and nothing else. RunTask takes a task
        # definition ARN, and revisions change on each deploy, so the wildcard is on the
        # revision rather than on the name.
        Sid      = "StartWorkerTasks"
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = ["${replace(aws_ecs_task_definition.worker.arn, "/:\\d+$/", "")}:*"]
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn }
        }
      },
      {
        # RunTask hands the execution role to ECS, and handing a role to a service is its
        # own permission. The condition is what stops this from being a general
        # role-assumption primitive: it can pass this one role, and only to ECS tasks.
        Sid      = "PassExecutionRole"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.task_execution.arn]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
      {
        # For the concurrency cap. The API counts what is already running before starting
        # another, so a burst of submissions cannot start a task per submission.
        Sid      = "CountRunningWorkers"
        Effect   = "Allow"
        Action   = ["ecs:ListTasks", "ecs:DescribeTasks"]
        Resource = ["*"]
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn }
        }
      },
    ]
  })
}

# Min 1 because the service is the front door and a cold start on every first request is a
# worse trade than a few dollars. Max 2 is a ceiling against a traffic spike, not a
# throughput plan. Two instances are safe now that the rate limiter is a Postgres table
# rather than a per-process map, which is the change that made a second instance legal.
resource "aws_apprunner_auto_scaling_configuration_version" "api" {
  auto_scaling_configuration_name = "battle-cloud-api"

  max_concurrency = 100
  min_size        = 1
  max_size        = 2
}

resource "aws_apprunner_service" "api" {
  service_name = "battle-cloud-api"

  source_configuration {
    # Off because ECR tags here are immutable and every push carries a new commit sha, so
    # there is no moving tag for App Runner to watch. A deploy bumps var.api_image_tag.
    auto_deployments_enabled = false

    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_ecr_access.arn
    }

    image_repository {
      image_identifier      = "${aws_ecr_repository.image["api"].repository_url}:${var.api_image_tag}"
      image_repository_type = "ECR"

      image_configuration {
        port = "8080"

        runtime_environment_variables = {
          PORT                       = "8080"
          SUBMIT_RATE_LIMIT_PER_HOUR = "20"

          # Identity fields, and they have to match what the worker image was built from.
          # A wrong POKE_ENGINE_TAG only costs cache misses; a wrong USAGE_STATS_DATASET
          # leaves every submission queued forever, because a worker claims only jobs
          # naming its own dataset.
          POKE_ENGINE_TAG     = var.poke_engine_tag
          USAGE_STATS_DATASET = var.usage_stats_dataset

          # Read by the RunTask trigger, which is not written yet. Set here so the service
          # already knows what to start once it is.
          WORKER_CLUSTER         = aws_ecs_cluster.main.name
          WORKER_TASK_DEFINITION = aws_ecs_task_definition.worker.family
          WORKER_SUBNET_IDS      = join(",", aws_subnet.public[*].id)
          WORKER_SECURITY_GROUP  = aws_security_group.worker.id
          WORKER_MAX_TASKS       = tostring(var.worker_max_concurrent_tasks)
        }

        runtime_environment_secrets = {
          DATABASE_URL = aws_ssm_parameter.database_url["api"].arn
        }
      }
    }
  }

  instance_configuration {
    # The smallest App Runner offers. The API parses replay JSON and writes rows; the
    # analysis it fronts happens in a 4 vCPU task somewhere else.
    cpu               = "256"
    memory            = "512"
    instance_role_arn = aws_iam_role.apprunner_instance.arn
  }

  health_check_configuration {
    # /healthz and not /readyz, deliberately. /readyz checks the database, and wiring a
    # dependency check to the liveness probe means a Neon blip recycles instances that are
    # themselves fine, turning a brief upstream failure into a longer local one.
    protocol            = "HTTP"
    path                = "/healthz"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.api.arn
}
