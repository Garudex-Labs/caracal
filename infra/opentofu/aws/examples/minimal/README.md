<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Minimal example

End-to-end working call of the Caracal AWS module with sensible defaults.

```bash
cd infra/opentofu/aws/examples/minimal
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars

tofu init
tofu plan -out tf.plan
tofu apply tf.plan
```

A clean apply takes ~12–15 minutes (RDS provisioning dominates).

When it finishes:

```bash
tofu output app_url
$(tofu output -raw data_host_ssm_session_command)
```

## What gets provisioned

Everything the parent module provisions. See [`../../README.md`](../../README.md). In its default form (no `domain_name`), this example brings up:

- VPC with 2-AZ public/private subnets, NAT gateway
- ALB on HTTP only (no HTTPS - supply `domain_name` + `route53_zone_id` for ACM)
- ECS Fargate: 2× api, 2× auth, 2× web
- RDS Postgres 16 (Multi-AZ on `prod`)
- ElastiCache Redis 7 (2-node failover on `prod`)
- One EC2 (t3.large) hosting ClickHouse, 100 GB EBS. Set `observability_stack = "grafana"` for bundled dashboards.
- S3 backups bucket with lifecycle to Glacier
- CloudWatch log groups per service

## Tearing it down

```bash
tofu destroy
```

If the apply hit `deletion_protection = true` on RDS (the `prod` default), set `environment = "staging"` first or remove the protection in the AWS console.
