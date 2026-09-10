# The bucket this configuration's own state moves into.
#
# The bootstrap knot is real but small: a backend cannot be configured before the bucket
# exists, so the bucket is created by a run using local state, and a second `init` adopts
# it. That is a one-time two-step, written out in README.md, and it is why this resource
# looks like it is doing something circular. After the migration this bucket holds the
# state that describes the bucket, which is fine: Terraform reads the backend before it
# reads the state.
#
# Locking is S3 native conditional writes (`use_lockfile = true` in the backend block),
# which is why there is no DynamoDB table here. That was the standard companion until S3
# grew the primitive that makes it unnecessary.

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name

  # Deleting this bucket deletes the record of everything else in this account, so the
  # provider refuses unless someone removes this first.
  lifecycle {
    prevent_destroy = true
  }
}

# Every apply overwrites one object. Versioning is what makes a bad apply, or a corrupted
# push, recoverable rather than final.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      # SSE-S3 rather than a KMS key. State here carries no secret values by design --
      # secrets.tf keeps the connection strings out of it -- so a customer-managed key
      # would add a monthly charge and a second thing to lose.
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Old versions of the state accumulate on every apply and none of them is large. Ninety
# days is long enough to recover from a mistake nobody noticed for a season.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}
