# The sweep: the same worker task, on a schedule, as the floor under the API's trigger.
#
# It exists because the trigger is an optimization. Jobs are rows claimed with FOR UPDATE
# SKIP LOCKED, so a RunTask call that is throttled, fails, or never happens delays a job
# rather than losing it. The sweep is what bounds that delay.
#
# The interval is an hour, and the deploy plan said "every few minutes". The plan was
# written without the arithmetic. Fargate bills a one-minute minimum per task, and this
# task is 4 vCPU and 8 GB at about $0.198 an hour, so every execution costs about $0.0033
# whether it finds work or exits immediately:
#
#   every  5 minutes   288 runs/day   about $28/month
#   every 15 minutes    96 runs/day   about $9.50/month
#   every 60 minutes    24 runs/day   about $2.40/month
#
# Twenty-eight dollars a month to poll an empty queue is more than the API and the database
# put together, on a service with no users. An hour is the honest default while the trigger
# is the real path and this is the safety net. Lower it with var.sweep_interval_minutes when
# there is traffic to justify it, and know what the row above costs before doing so.
#
# The cheaper shape, if the latency ever matters more than the money, is a Lambda that
# checks for queued work and calls RunTask only when there is some. That is near-free at any
# interval and it is more moving parts: a function, a Postgres driver in it, and the
# connection string in a third place. Not worth it yet.

resource "aws_iam_role" "scheduler" {
  name = "battle-cloud-scheduler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "scheduler.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  name = "run-worker-task"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = ["${replace(aws_ecs_task_definition.worker.arn, "/:\\d+$/", "")}:*"]
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.task_execution.arn]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_scheduler_schedule" "sweep" {
  name        = "battle-cloud-worker-sweep"
  description = "Drains any queued analysis the API's RunTask trigger did not start a worker for."

  # Nothing here is time-sensitive to the minute, and a window lets AWS spread load.
  flexible_time_window {
    mode                      = "FLEXIBLE"
    maximum_window_in_minutes = 5
  }

  schedule_expression          = "rate(${var.sweep_interval_minutes} minutes)"
  schedule_expression_timezone = "UTC"

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      # Family without a revision, so the schedule follows a redeploy instead of pinning
      # the revision that existed when it was created.
      task_definition_arn = replace(aws_ecs_task_definition.worker.arn, "/:\\d+$/", "")
      launch_type         = "FARGATE"
      task_count          = 1

      network_configuration {
        subnets = aws_subnet.public[*].id
        # Public subnets and no NAT, so the task needs a public IP to reach ECR, Neon, and
        # CloudWatch. Without this it starts and then fails to pull.
        assign_public_ip = true
        security_groups  = [aws_security_group.worker.id]
      }
    }

    retry_policy {
      # One attempt. A missed sweep is covered by the next one, and a retry storm against
      # a real outage would start tasks that all fail the same way and bill for it.
      maximum_retry_attempts = 0
    }
  }
}
