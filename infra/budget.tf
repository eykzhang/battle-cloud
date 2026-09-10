# A ceiling on surprise.
#
# Nothing here should cost more than a few dollars a month: the Lambda is free at this
# traffic, the HTTP API is a dollar per million requests, and the real money is the Fargate
# worker at $0.198 an hour while it runs. The reason to watch it anyway is that a public
# endpoint plus a per-submission Fargate task is exactly the shape that turns an abuse
# problem into a bill. The API Gateway stage throttle is the first line and this is the
# second: the throttle caps the rate, and this tells you if the cap was wrong.
#
# AWS Budgets rather than a CloudWatch alarm on EstimatedCharges: that metric exists only
# in us-east-1, which would mean a second provider alias for one alarm, and it fires on a
# metric that updates a few times a day. Budgets covers actual and forecasted spend and
# emails without an SNS topic in between.
#
# Skipped entirely when no address is set, so `terraform apply` still works for anyone who
# has not configured one rather than failing on a missing variable.

resource "aws_budgets_budget" "monthly" {
  count = var.budget_alert_email == "" ? 0 : 1

  name         = "battle-cloud-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Half the budget, already spent. Early enough to look into it while the month is young.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  # Forecast to exceed the whole budget. This is the one that catches a runaway early,
  # since a worker loop or a scraper shows up in the forecast days before the actual.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
