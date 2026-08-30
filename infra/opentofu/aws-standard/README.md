# Caracal AWS Standard Module

Single-account, cost-optimized OpenTofu deployment for Caracal on AWS. Runs the full stack (API, auth, web, init) on two EC2 instances - one ECS EC2 cluster node for containers and one data-tier host for stateful services.

## Architecture

```
Internet
    |
   ALB (public subnets)
    |
    +-- /api/auth/* --> ECS EC2: auth container (port 8001)
    +-- /api/* --> ECS EC2: api container (port 8080)
    +-- /grafana/*      --> Data host: Grafana (port 8002)
    +-- /* (default)    --> ECS EC2: web container (port 8000)
    |
Private subnets:
    +-- ECS EC2 instance (t3.large) running api, auth, web tasks
    +-- Data host EC2 (t3.medium) running:
        - Postgres 18 (port 5432)
        - Redis 8 (port 6379)
        - ClickHouse 26.5 (ports 8123, 9000)
        - Grafana (port 8002)
        - Prometheus (port 9090)
```

Internal DNS (`caracal.internal` private Route53 zone) connects ECS tasks to the data host via stable names: `postgres.caracal.internal`, `redis.caracal.internal`, `clickhouse.caracal.internal`.

## Estimated Monthly Cost

| Preset | ECS Instance | Data Host | EBS | NAT Gateway | ALB | Total |
|--------|-------------|-----------|-----|-------------|-----|-------|
| small  | t3.large (~$60) | t3.medium (~$30) | 50 GB ($4) | ~$32 | ~$16 | ~$120/mo |
| medium | t3.large (~$60) | t3.medium (~$30) | 100 GB ($8) | ~$32 | ~$16 | ~$155/mo |

## Usage

```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

tofu init
tofu plan
tofu apply
```

## BYO-VPC

To deploy into an existing VPC, set `vpc_id`, `public_subnet_ids`, and `private_subnet_ids` in your tfvars. The module will skip VPC/subnet/IGW/NAT creation.

## TLS

Set `domain_name`, `route53_zone_id`, and `enable_tls = true` to provision an ACM certificate with DNS validation and enable HTTPS on the ALB.

## Differences from Enterprise Module

| Feature | Standard | Enterprise (`infra/opentofu/aws/`) |
|---------|----------|--------------------------------------|
| Compute | ECS on EC2 (1 instance) | ECS Fargate (auto-scaling) |
| Database | Postgres on EC2 | RDS Postgres (managed) |
| Cache | Redis on EC2 | ElastiCache Redis (managed) |
| ClickHouse | EC2 (same host) | EC2 or ClickHouse Cloud |
| HA | Single-AZ data tier | Multi-AZ managed services |
| Cost | ~$120-155/mo | ~$300-800/mo |
| BYO Security Groups | No | Yes |
| VPC Flow Logs | No | Yes |
| Auto-scaling | ASG for ECS instances | Fargate + Application Auto Scaling |

## SPDX

SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
SPDX-License-Identifier: Apache-2.0
