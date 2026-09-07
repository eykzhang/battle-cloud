# The worker runs as a Fargate task started when there is work, drains the queue until
# nothing is left for its own engine build, and exits 0.
#
# The shape follows from cost. A 4 vCPU, 8 GB task is about $0.198 an hour, so an always-on
# worker is roughly $145 a month to wait for a submission this service does not yet receive,
# against about $0.002 for a 40-second analysis. Per-burst draining is only viable because
# the cold start is small: 0.13 s to import the usage-stats module and 0.35 s to parse the
# 13.7 MB file, measured 2026-09-06, plus roughly 1.1 s of per-execution overhead on an
# already-pulled image. See notes/gotcha-usage-stats-cold-start-is-cheap.md.
#
# Correctness does not depend on the trigger. Jobs live in a Postgres table claimed with
# FOR UPDATE SKIP LOCKED, so a RunTask call that never happens delays a job until the next
# execution and cannot lose one. The EventBridge schedule in scheduler.tf is the floor.

resource "aws_ecs_cluster" "main" {
  name = "battle-cloud"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_cloudwatch_log_group" "worker" {
  name = "/battle-cloud/worker"

  # Long enough to debug a bad week, short enough that ingestion is the only real cost.
  # A drained burst writes a few dozen lines.
  retention_in_days = 14
}

# Pulls the image, writes logs, and decrypts the connection string. This is the role ECS
# itself uses before the container exists, which is why the parameter read lives here
# rather than on a task role: the value is injected into the container's environment by the
# agent, so the container never calls SSM and needs no AWS permissions of its own.
resource "aws_iam_role" "task_execution" {
  name = "battle-cloud-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The managed policy above covers ECR and logs and says nothing about SSM.
resource "aws_iam_role_policy" "task_execution_secrets" {
  name = "read-database-url"
  role = aws_iam_role.task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = [aws_ssm_parameter.database_url["worker"].arn]
      },
    ]
  })
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "battle-cloud-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  execution_role_arn       = aws_iam_role.task_execution.arn

  # 4 vCPU and 8 GB. Not a performance preference: `ladder-parity` fixes threads at 4 and
  # `threads` is an identity field, so a worker with fewer cores produces analyses under a
  # different identity that are not comparable with battle-brain's bundled fixtures. The
  # startup check in WorkerConfig.from_env refuses concurrency x threads above the core
  # count for the same reason. Fargate vCPU is also not burstable, which matters more than
  # the size: the search is budgeted in wall-clock milliseconds, so a throttled core
  # returns a shallower analysis rather than a slower one, and the document records only
  # normalized visitShare, so nothing downstream can see that it happened.
  cpu    = 4096
  memory = 8192

  # CI builds amd64 and the laptop is arm64. The deployed image is the one CI proved.
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  # No task role. The worker talks to Postgres and to nothing in AWS.

  container_definitions = jsonencode([{
    name      = "worker"
    image     = "${aws_ecr_repository.image["worker"].repository_url}:${var.worker_image_tag}"
    essential = true

    # POKE_ENGINE_TAG, USAGE_STATS_DATASET, ENGINE_DATA_DIR, and QUERIES_DIR are set in the
    # image's runtime stage from the build arguments that selected the wheel and the stats
    # file, and are deliberately not repeated here. The image describes its own build; a
    # value set at deploy time could disagree with what the image actually carries, and the
    # failure mode of that is silent, because a worker claims only jobs naming its own
    # build and would simply claim nothing while both tiers looked healthy.
    environment = [
      { name = "WORKER_MODE", value = "drain" },
      { name = "WORKER_CONCURRENCY", value = "1" },
      { name = "ENGINE_THREADS", value = "4" },
      { name = "JOB_LEASE_SECONDS", value = "900" },
      { name = "JOB_MAX_ATTEMPTS", value = "3" },
    ]

    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url["worker"].arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.worker.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
      }
    }
  }])
}
