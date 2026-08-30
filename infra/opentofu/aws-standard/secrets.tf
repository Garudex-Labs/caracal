# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

# ── Generated secrets ─────────────────────────────────────────────────────

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "random_password" "clickhouse" {
  length  = 32
  special = false
}

resource "random_password" "secret_key" {
  length  = 48
  special = false
}

resource "random_password" "auth_internal_secret" {
  length  = 48
  special = false
}

resource "random_password" "better_auth_secret" {
  length  = 48
  special = false
}

# ── SSM Parameter Store ───────────────────────────────────────────────────
# Connection URLs reference internal DNS names resolved via the private Route53 zone.

locals {
  connection_urls = {
    "DATABASE_URL"   = "postgresql://caracal:${random_password.db.result}@postgres.${var.internal_dns_zone}:5432/caracal"
    "REDIS_URL"      = "redis://redis.${var.internal_dns_zone}:6379"
    "CLICKHOUSE_URL" = "clickhouse://default:${random_password.clickhouse.result}@clickhouse.${var.internal_dns_zone}:8123/caracal"
  }
}

resource "aws_ssm_parameter" "urls" {
  for_each = local.connection_urls

  name  = "${local.ssm_prefix}/${each.key}"
  type  = "SecureString"
  value = each.value

  tags = { Name = "${local.name}-${lower(each.key)}" }
}

locals {
  raw_secrets = {
    "SECRET_KEY"           = random_password.secret_key.result
    "AUTH_INTERNAL_SECRET" = random_password.auth_internal_secret.result
    "BETTER_AUTH_SECRET"   = random_password.better_auth_secret.result
  }
}

resource "aws_ssm_parameter" "app" {
  for_each = local.raw_secrets

  name  = "${local.ssm_prefix}/${each.key}"
  type  = "SecureString"
  value = each.value

  tags = { Name = "${local.name}-${lower(each.key)}" }
}

resource "aws_ssm_parameter" "db_password" {
  name  = "${local.ssm_prefix}/DB_PASSWORD"
  type  = "SecureString"
  value = random_password.db.result

  tags = { Name = "${local.name}-db-password" }
}

resource "aws_ssm_parameter" "clickhouse_password" {
  name  = "${local.ssm_prefix}/CLICKHOUSE_PASSWORD"
  type  = "SecureString"
  value = random_password.clickhouse.result

  tags = { Name = "${local.name}-clickhouse-password" }
}
