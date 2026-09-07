# GitHub Actions authenticates to AWS by OIDC, so there is no access key to store in the
# repository and none to rotate. A workflow run presents a token whose `sub` says which
# repository and which ref produced it, and the trust policy below is what decides whether
# that is allowed to become AWS credentials.

data "tls_certificate" "github" {
  url = "https://token.actions.githubusercontent.com/.well-known/openid-configuration"
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # AWS stopped verifying thumbprints for IdPs on well-known certificate authorities, and
  # GitHub is one, so this list is effectively ignored. It is computed rather than
  # hardcoded anyway: a pinned hex string is a thing that expires silently, and provider
  # versions before 5.x still require the argument.
  thumbprint_list = data.tls_certificate.github.certificates[*].sha1_fingerprint
}

locals {
  github_owner = split("/", var.github_repository)[0]
  github_name  = split("/", var.github_repository)[1]

  # `repo:<owner>@<owner_id>/<repo>@<repo_id>:ref:refs/heads/<branch>`, which is what a
  # workflow run actually presents. Both halves are kept: the ids are what the policy
  # matches on, and the names are what makes it readable to a person.
  oidc_subject = "repo:${local.github_owner}@${var.github_owner_id}/${local.github_name}@${var.github_repository_id}:ref:refs/heads/${var.deploy_branch}"
}

data "aws_iam_policy_document" "github_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # StringEquals on the exact ref. StringLike on `repo:owner/repo:*` is the common form
    # and it grants the role to every branch and every pull request workflow in the
    # repository, which is a much larger set of code than the one allowed to publish
    # images.
    #
    # The subject carries GitHub's immutable numeric ids, not the names:
    #
    #   repo:eykzhang@214009084/battle-cloud@1359218725:ref:refs/heads/main
    #
    # rather than the documented-everywhere `repo:eykzhang/battle-cloud:ref:refs/heads/main`.
    # The name form was what this policy matched on first, and the assume failed with
    # `Not authorized to perform sts:AssumeRoleWithWebIdentity`, which says nothing about
    # which claim disagreed. CloudTrail's `userIdentity.principalId` on the denied event is
    # where the presented subject is actually readable.
    #
    # Matching the ids rather than the names is the stronger position and worth keeping on
    # purpose: a name-based subject is a claim on a string that can change hands, so a
    # repository that is renamed or deleted frees a subject some other repository can later
    # present. The ids never move. The cost is that this breaks loudly if GitHub reverts
    # the format, which is the correct direction for it to fail.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.oidc_subject]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = "battle-cloud-github-actions"
  description        = "Assumed by CI on ${var.github_repository}@${var.deploy_branch} to publish images."
  assume_role_policy = data.aws_iam_policy_document.github_trust.json

  # An hour is longer than any job here needs. The token is scoped to one workflow run
  # regardless, but a short ceiling limits what a leaked session buys.
  max_session_duration = 3600
}

data "aws_iam_policy_document" "ecr_push" {
  statement {
    sid     = "AuthorizeAgainstTheRegistry"
    effect  = "Allow"
    actions = ["ecr:GetAuthorizationToken"]
    # This one cannot be scoped to a repository: the token is issued for the registry as a
    # whole, so `*` is the only resource AWS accepts here.
    resources = ["*"]
  }

  statement {
    sid    = "PushAndReadProjectImages"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      # Reads, so a copy can skip layers that are already there rather than re-uploading
      # them, and so the workflow can confirm what it just pushed.
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
    ]
    resources = [for repository in aws_ecr_repository.image : repository.arn]
  }

  # Deliberately absent: ecs:RunTask, iam:PassRole, and anything else the deploy will
  # need. Those arrive with the resources they act on, so that this role never grants more
  # than the step it exists for.
}

resource "aws_iam_role_policy" "ecr_push" {
  name   = "publish-images"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.ecr_push.json
}
