# Networking exists for the worker, and only for the worker.
#
# The API does not need it. App Runner runs the API outside any VPC of ours, which is the
# whole point of the Neon decision: attaching a VPC connector would route the API's
# outbound traffic through that VPC, and its calls to Showdown would then need a NAT
# gateway at about $32 a month. See notes/decision-neon-over-rds-to-keep-the-api-out-of-a-vpc.md.
#
# A Fargate task has no such escape. It runs with an ENI in a subnet, so it needs one.
# The subnets here are public and tasks get a public IP, which means egress leaves through
# the internet gateway and costs nothing. The alternative, private subnets, would need the
# same NAT gateway the API arrangement exists to avoid, to reach three things the worker
# cannot do without: ECR to pull its image, Neon to claim jobs, and CloudWatch to log.
#
# A public IP is not an open door. The security group below allows no inbound traffic at
# all, and nothing about the worker listens.

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "battle-cloud" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "battle-cloud" }
}

# Two, in different availability zones. One would work and would also mean a zone with a
# capacity problem is a worker that cannot start, and RunTask picks whichever subnet it is
# handed. Subnets cost nothing.
resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "battle-cloud-public-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "battle-cloud-public" }
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# No ingress rules, deliberately and not by omission. The worker is a queue consumer: it
# opens connections to Postgres, to ECR, and to CloudWatch, and accepts none. An empty
# ingress block is the accurate description of that, and it is what makes a public IP
# uninteresting to anything scanning for one.
resource "aws_security_group" "worker" {
  name        = "battle-cloud-worker"
  description = "Worker tasks. Egress only."
  vpc_id      = aws_vpc.main.id

  egress {
    description = "Postgres at Neon, ECR, and CloudWatch, all over the public internet."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "battle-cloud-worker" }
}
