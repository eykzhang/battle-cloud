# The Neon connection string, as two SSM parameters rather than one.
#
# Two, because the tiers do not agree on what a connection string means. `pg` treats
# `sslmode=require` as an alias for `verify-full` today and says so in a warning that also
# says it will stop at pg v9; psycopg follows libpq, where `require` means encrypt without
# verifying anything. One string would therefore give the API a verified connection and the
# worker an unverified one, silently. Writing the mode each tier should get, into the
# parameter that tier reads, is the version of that fact a deploy can act on. See
# notes/gotcha-sslmode-require-means-different-things-per-driver.md, including the part
# about what still has to be tested inside the worker image.
#
# SSM Parameter Store rather than Secrets Manager: standard parameters are free and Secrets
# Manager is $0.40 per secret per month. For two values on a service with no users, that is
# the whole comparison. Rotation is the argument for Secrets Manager and Neon is not
# integrated with it, so rotation here is a console action either way.
#
# The values are not in Terraform, and `ignore_changes` is what keeps them out. A value set
# in configuration is a value in state, and state here is a file on a laptop. Terraform
# creates the parameter with a placeholder and never looks at the contents again; the real
# string is written once with `aws ssm put-parameter --overwrite`.

locals {
  database_url_parameters = {
    api = {
      # `pg` already behaves this way. Naming it pins the behavior across the v9 change
      # instead of inheriting whatever the default becomes.
      sslmode     = "verify-full"
      description = "Neon connection string for the API. sslmode=verify-full."
    }
    worker = {
      # `require` until `verify-full&sslrootcert=system` has actually been tried inside the
      # worker image. It fails from a laptop, where the psycopg binary wheel's bundled
      # OpenSSL has no system trust store to read, and that result says nothing about a
      # Debian-based image where ca-certificates is present.
      sslmode     = "require"
      description = "Neon connection string for the worker. sslmode=require, pending a verify-full test inside the image."
    }
  }
}

resource "aws_ssm_parameter" "database_url" {
  for_each = local.database_url_parameters

  name        = "/battle-cloud/database-url/${each.key}"
  description = each.value.description
  type        = "SecureString"

  # Overwritten out of band. If a deploy ever reads this literal value, the parameter was
  # never populated and the tier reading it will fail its own startup check, which is the
  # loud version of that mistake.
  value = "postgresql://placeholder-set-with-aws-ssm-put-parameter"

  lifecycle {
    ignore_changes = [value]
  }

  tags = { Tier = each.key }
}
