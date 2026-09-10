# Infrastructure

Terraform for the AWS side of battle-cloud: the API on Lambda behind an API Gateway HTTP API,
the worker as a Fargate task, the registry CI publishes to, and the identity CI authenticates
with. Applied into account `618426070248` in `us-east-2`.

Postgres is not here and will not be: it is Neon, outside AWS. That is the decision that keeps
the API off a VPC connector and therefore off a $32/month NAT gateway for its outbound calls to
Showdown. See `../notes/decision-neon-over-rds-to-keep-the-api-out-of-a-vpc.md`.

## Why the API is a Lambda function

App Runner was the plan, and `apprunner.tf` existed for two days without ever creating a
resource. Every attempt failed with `SubscriptionRequiredException: The AWS Access Key Id needs
a subscription for the service`, in us-east-2, us-east-1, and us-west-2 alike, from an IAM user
holding `AdministratorAccess`, with a verified payment method, while ECS, ECR, SSM, EventBridge,
Lightsail, and Amplify all accepted the same credentials in the same session. It is App Runner
specifically, it is account-level, and three days did not clear it.

Lambda is also the cheaper answer, which is why this is not a workaround to undo later. One
analysis session is roughly sixteen requests, so the API tier costs about **$0.07 per thousand
analyses served**; App Runner's floor is a few dollars a month whether or not anyone calls it.
Both are noise against the Fargate task that does the analysis, at about $0.0066 for two
minutes of four vCPUs: the front door is roughly 1% of what the engine costs. Above about 5M
requests a month the comparison inverts and a flat always-on container wins.

## What this creates

| Resource | Why |
|---|---|
| A Lambda function, arm64, 1024 MB | The API. An esbuild bundle, not the container image: Lambda's runtime client will not load this project's `.ts` entry. 1024 MB is a latency setting, since Lambda scales CPU with memory |
| An API Gateway HTTP API and `$default` stage | HTTPS, a hostname, and CORS for the web client. HTTP API rather than REST: same integration, a third of the price |
| A stage throttle at 20 rps, 40 burst | The spend ceiling. This account's Lambda concurrency limit is the new-account default of 10, and AWS refuses any reservation leaving under 100 unreserved, so the cap lives here instead |
| An ECS cluster, task definition, and security group | The worker: 4 vCPU and 8 GB, started per burst, drains the queue, exits |
| An EventBridge schedule | Runs a worker hourly regardless of any trigger, so a dropped `RunTask` costs latency and never a job |
| Three ECR repositories, immutable tags | `battle-cloud/api`, `battle-cloud/migrate`, `battle-cloud/worker`. Immutable so a deployed digest cannot change under a running service |
| A lifecycle policy per repository | Untagged manifests expire after a day; the last ten tagged images are a rollback window |
| Two SSM SecureString parameters | The Neon connection string, one per tier, written out of band. Terraform never holds the value |
| A GitHub OIDC provider and one CI role | So CI authenticates with a short-lived token instead of a stored access key. Scoped to `main` of this repository, by GitHub's immutable numeric ids |
| A VPC, two public subnets, an internet gateway | For the worker only. Public subnets with public IPs, because the alternative is a NAT gateway |
| Two CloudWatch log groups, 14-day retention | Created here rather than left to Lambda, which would create one with no expiry and bill storage forever |

Cost at rest: ECR storage at roughly $0.30 a month, the hourly sweep at about $0.0033 an
execution, and nothing else. IAM, the OIDC provider, log groups, and an idle Lambda are free.

## Applying it

Needs Terraform 1.9 or newer and credentials for the account with permission to create IAM
roles. There is no CI apply and no remote state yet, so this runs from a laptop.

Terraform runs on the host here, not in a container. The laptop authenticates with `aws
login`, whose session the AWS provider cannot read, so the provider gets credentials by
shelling out to the CLI instead. Add this profile to `~/.aws/config` once:

```
[profile tf]
region = us-east-2
credential_process = aws configure export-credentials --profile default --format process
```

Nothing is written to disk by that, and it keeps working across a re-login as a different
identity. See `notes/gotcha-aws-login-sessions-are-invisible-to-terraform.md`.

```
cd infra
AWS_PROFILE=tf terraform init
AWS_PROFILE=tf terraform plan      # read it; IAM roles are the part worth reading
AWS_PROFILE=tf terraform apply
```

The Lambda function is created from `../api/dist/lambda.zip`, so build it first with
`npm --prefix api run bundle`. After creation, `filename` and `source_code_hash` are under
`ignore_changes`: **Terraform owns the function's configuration and CI owns its code.** A
deploy is the `deploy-api` job calling `update-function-code`, and an unrelated apply from a
laptop must not overwrite it with whatever zip happens to be on disk.

Then wire CI to it, using the outputs:

```
gh variable set AWS_ROLE_ARN  --body "$(terraform output -raw github_actions_role_arn)"
gh variable set ECR_REGISTRY  --body "$(terraform output -raw ecr_registry)"
gh variable set AWS_REGION    --body "us-east-2"
gh variable set API_FUNCTION_NAME --body "$(terraform output -raw api_function_name)"
```

The `mirror-to-ecr` and `deploy-api` jobs in `.github/workflows/ci.yml` are skipped while
their variables are unset, so nothing breaks before this is applied and they start running once
it is. All four are set.

## Cost alerts

`budget.tf` creates an AWS Budget with two notifications: half the monthly figure actually
spent, and the whole of it forecast. It is skipped entirely unless an address is set, so
`apply` works without one.

```
# infra/terraform.tfvars
budget_alert_email = "you@example.com"
```

`monthly_budget_usd` defaults to 10, which is several times what this should cost. A breach
means something is wrong, not that the project grew. The API Gateway stage throttle is the
first defense against a runaway bill; this is how you find out the throttle was set wrong.

Budgets is a billing API, so it needs IAM access to billing enabled on the account. That is a
root-only setting: **Account → IAM user and role access to billing information → Activate**.
Without it the apply fails with AccessDenied on `budgets:CreateBudget`, which does not mention
the setting.

## State

Local until `state.tf`'s bucket exists, then S3. The bootstrap is a forced two-step, since a
backend cannot reference a bucket a later run creates:

```
AWS_PROFILE=tf terraform apply                 # creates the bucket
# uncomment the backend block in versions.tf
AWS_PROFILE=tf terraform init -migrate-state   # answer yes; copies state up
```

The local `terraform.tfstate` stays on disk afterwards as a backup and stops being read. The
bucket is versioned, so a bad apply or a corrupted push is recoverable, with old versions
expiring after ninety days. Locking is `use_lockfile = true`, S3 native conditional writes,
which is why there is no DynamoDB table: that was the mandatory companion until S3 grew the
primitive that replaces it.

`prevent_destroy` is set on the bucket. It holds the record of everything else in the account,
and a `terraform destroy` that took it out first would leave the rest orphaned and invisible.
