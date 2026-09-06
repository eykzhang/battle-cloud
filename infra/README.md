# Infrastructure

Terraform for the AWS side of battle-cloud. What exists here today is the registry and the
way CI authenticates to it. The compute (the API service, the worker task, its trigger) is
Stage 3 of `.code-foundations/plans/2026-09-06-battle-cloud-deploy.md` and is not written yet.

Postgres is not here either, and will not be: it is Neon, outside AWS. That is the decision
that keeps the API on App Runner without a VPC connector, and therefore without a NAT gateway
for its outbound calls to Showdown.

## What this creates

| Resource | Why |
|---|---|
| Three ECR repositories, immutable tags | `battle-cloud/api`, `battle-cloud/migrate`, `battle-cloud/worker`. Immutable so a deployed digest cannot change under a running service |
| A lifecycle policy per repository | Untagged manifests expire after a day; the last ten tagged images are kept as a rollback window |
| A GitHub OIDC provider | So CI authenticates with a short-lived token instead of a stored access key |
| One IAM role, ECR push only | Assumable only by a workflow run on `main` of this repository |

Cost: ECR storage is $0.10 per GB-month. Thirty images at roughly 100 MB compressed is
about $0.30 a month. IAM and the OIDC provider are free.

## Applying it

Needs Terraform 1.9 or newer and credentials for the account with permission to create IAM
roles. There is no CI apply and no remote state yet, so this runs from a laptop.

```
cd infra
terraform init
terraform plan      # read it; IAM roles are the part worth reading
terraform apply
```

Then wire CI to it, using the outputs:

```
gh variable set AWS_ROLE_ARN  --body "$(terraform output -raw github_actions_role_arn)"
gh variable set ECR_REGISTRY  --body "$(terraform output -raw ecr_registry)"
gh variable set AWS_REGION    --body "us-east-1"
```

The `mirror-to-ecr` job in `.github/workflows/ci.yml` is skipped while `AWS_ROLE_ARN` is
unset, so nothing breaks before this is applied and the job starts running once it is.

## State

Local, on purpose, and it is the first thing to revisit. An S3 backend needs a bucket, and
creating that bucket with the same Terraform whose state it holds is the usual bootstrap
knot. Local state is honest for one operator applying from one machine, and it is lost with
that machine. `versions.tf` records what the move looks like.
