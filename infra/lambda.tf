# The API: a Lambda function behind an API Gateway HTTP API.
#
# This replaces App Runner, which was written first and never created. That account returns
# SubscriptionRequiredException for App Runner in us-east-2, us-east-1, and us-west-2 alike,
# from an IAM user holding AdministratorAccess, with a verified payment method, while ECS,
# ECR, SSM, EventBridge, Lightsail, and Amplify all accept writes from the same credentials.
# Three days after account creation it had not cleared. See
# notes/decision-lambda-over-app-runner.md.
#
# Cost is the reason this is not a reluctant substitute. App Runner's floor is a few dollars
# a month to idle. This is about $0.07 per thousand analyses served and nothing at all when
# no one calls it, against a Fargate worker that costs roughly $0.007 for a single analysis:
# the front door is about 1% of what the engine it fronts costs.
#
# What is given up: a cold start of roughly a third of a second on the first request after a
# quiet period, and a 29-second ceiling on any single request, which is API Gateway's
# integration timeout. Neither binds. The API never waits for an analysis -- it enqueues a
# job and returns a handle -- so its slowest path is a replay fetch from Showdown.

resource "aws_iam_role" "api" {
  name = "battle-cloud-api"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "api_basic" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "api" {
  name = "start-workers-and-read-config"
  role = aws_iam_role.api.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Lambda has no equivalent of the ECS agent's secret injection, so the function
        # reads this itself at cold start. The alternative is a plaintext environment
        # variable in the function's configuration, which would also put the connection
        # string into Terraform state -- exactly what secrets.tf is built to avoid.
        Sid      = "ReadDatabaseUrl"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = [aws_ssm_parameter.database_url["api"].arn]
      },
      {
        # Every revision of this one family and nothing else. RunTask takes a task
        # definition ARN and revisions change on each deploy, so the wildcard is on the
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
        # role-assumption primitive: this one role, and only to ECS tasks.
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
        # another, so a burst of submissions does not become a task per submission.
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

# Created here rather than left to Lambda, which would create it on first invocation with
# no expiry and bill storage forever.
resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/battle-cloud-api"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  function_name = "battle-cloud-api"
  role          = aws_iam_role.api.arn
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  architectures = ["arm64"]

  # An esbuild bundle, built by api/scripts/bundle.sh. Not the container image the API
  # Dockerfile produces: Lambda's runtime client resolves a handler as .mjs, .js, or .cjs
  # and will not load the .ts entry this project runs everywhere else.
  filename         = "${path.module}/../api/dist/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../api/dist/lambda.zip")

  # 1024 MB is a latency setting, not a memory one: Lambda scales CPU with memory, and the
  # bundle needs well under 200 MB. A cold start at 1024 is roughly half of one at 512 for
  # about the same total cost, since the price is memory multiplied by duration.
  memory_size = 1024

  # Longer than any path here should take. The replay fetch has its own 5-second timeout and
  # the ECS trigger its own 2-second ceiling; this is the backstop, under API Gateway's 29.
  timeout = 20

  # No reserved_concurrent_executions: this account's Lambda concurrency limit is the
  # new-account default of 10, and AWS refuses any reservation that would leave fewer than
  # 100 unreserved. The ceiling on spend is the API Gateway throttle below instead. That
  # limit is also worth knowing for the database: 10 instances at DB_POOL_MAX 2 is 20
  # connections, which Neon's pooler holds without noticing.

  environment {
    variables = {
      # Read at cold start rather than injected, for the reason in the IAM policy above.
      DATABASE_URL_PARAMETER = aws_ssm_parameter.database_url["api"].name

      # Two per instance, not the ten a long-lived server would take. A function instance
      # serves one request at a time, and the pool is multiplied by every warm instance.
      DB_POOL_MAX = "2"

      SUBMIT_RATE_LIMIT_PER_HOUR = "20"

      # Identity fields, and they have to match what the worker image was built from. A
      # wrong POKE_ENGINE_TAG only costs cache misses; a wrong USAGE_STATS_DATASET leaves
      # every submission queued forever, because a worker claims only jobs naming its own
      # dataset.
      POKE_ENGINE_TAG     = var.poke_engine_tag
      USAGE_STATS_DATASET = var.usage_stats_dataset

      # The RunTask trigger. All four or none: the API refuses to start on a partial set.
      WORKER_CLUSTER         = aws_ecs_cluster.main.name
      WORKER_TASK_DEFINITION = aws_ecs_task_definition.worker.family
      WORKER_SUBNET_IDS      = join(",", aws_subnet.public[*].id)
      WORKER_SECURITY_GROUP  = aws_security_group.worker.id
      WORKER_MAX_TASKS       = tostring(var.worker_max_concurrent_tasks)
    }
  }

  # Terraform owns this function's configuration; CI owns its code. The deploy job calls
  # update-function-code with a bundle built from the commit, so the zip on a laptop is
  # whatever was last built there and must not be allowed to overwrite a deploy on the next
  # unrelated apply. The file still seeds the function at create time.
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

# HTTP API rather than REST: same integration, a third of the price ($1.00 per million
# against $3.50), and none of the REST features this uses.
resource "aws_apigatewayv2_api" "api" {
  name          = "battle-cloud"
  protocol_type = "HTTP"

  # The web client is a static bundle on another origin, so it is a cross-origin caller by
  # construction. Open to any origin because every route is either public or rate-limited by
  # address, and there are no cookies and no credentials to protect: an origin allowlist
  # here would suggest a protection that is not the one doing the work.
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["content-type"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

# One catch-all route. Fastify already owns routing, and duplicating its table here would
# create a second place for a 404 to come from.
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/battle-cloud/api-gateway"
  retention_in_days = 14
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true

  # The spend ceiling. A submission costs a Fargate minute downstream, so the throttle is
  # set where a mistake or a scraper is expensive in cents rather than dollars: 20 requests
  # a second sustained, 40 in a burst. Job polling is what this has to leave room for, and
  # a client polls once a second.
  default_route_settings {
    throttling_rate_limit  = 20
    throttling_burst_limit = 40
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn
    # Enough to answer "what did this cost and how long did it take", which is the Stage 3.3
    # measurement, without logging request bodies.
    format = jsonencode({
      requestId       = "$context.requestId"
      ip              = "$context.identity.sourceIp"
      requestTime     = "$context.requestTime"
      routeKey        = "$context.routeKey"
      path            = "$context.path"
      method          = "$context.httpMethod"
      status          = "$context.status"
      responseLength  = "$context.responseLength"
      totalLatencyMs  = "$context.responseLatency"
      lambdaLatencyMs = "$context.integrationLatency"
      integrationErr  = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowInvokeFromHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  # This API and no other. Without the qualifier any API Gateway in any account could invoke
  # the function, since the service principal alone is not an identity.
  source_arn = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

# CI deploys this function's code. The grant lives beside the resource it acts on rather
# than in the CI role's original policy, which is the arrangement oidc.tf describes: the
# publish-images policy stays exactly what its name says, and every later permission
# arrives with the thing it touches.
resource "aws_iam_role_policy" "github_actions_deploy_api" {
  name = "deploy-api"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      # Code only. The function's configuration -- its role, its environment, its memory --
      # is Terraform's, so a workflow cannot quietly change what the function is allowed to
      # do. GetFunctionConfiguration is what `aws lambda wait function-updated` polls.
      Action = [
        "lambda:UpdateFunctionCode",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
      ]
      Resource = [aws_lambda_function.api.arn]
    }]
  })
}
