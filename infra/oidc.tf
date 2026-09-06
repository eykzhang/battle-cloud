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

    # StringEquals on the exact ref, not StringLike on `repo:owner/repo:*`. The wildcard
    # form is the common one and it grants the role to every branch and every pull request
    # workflow in the repository, which is a much larger set of code than the one that is
    # allowed to publish images.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/${var.deploy_branch}"]
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
