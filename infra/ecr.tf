# One repository per image. Named with a slash so they group in the console, which is the
# only thing the prefix does: ECR has no real namespaces.
locals {
  images = toset(["api", "migrate", "worker"])
}

resource "aws_ecr_repository" "image" {
  for_each = local.images

  name = "battle-cloud/${each.key}"

  # Immutable, and the workflow only ever pushes a commit-sha tag because of it. A moving
  # `main` tag would be convenient and would also mean a running service's image can
  # change under it, which is how a rollback stops being possible. GHCR keeps the moving
  # tag for humans; this registry is what a deploy pins.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    # Basic scanning is free and runs on push. It will not catch much in a distroless-ish
    # Python image, but the price is right and the finding it might catch is in the
    # Debian base rather than in anything written here.
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "expire" {
  for_each = aws_ecr_repository.image

  repository = each.value.name

  # Storage is $0.10 per GB-month. Three repositories times ten images times roughly
  # 100 MB compressed is a few dollars a year, so this exists to stop unbounded growth
  # rather than to save money.
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Untagged manifests are build residue, not history"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        # Must be the last rule: a tagStatus of "any" matches everything the rules above
        # did not.
        rulePriority = 2
        description  = "Keep a rollback window of ${var.image_retention_count} images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.image_retention_count
        }
        action = { type = "expire" }
      },
    ]
  })
}
