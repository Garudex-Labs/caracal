# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

locals {
  name     = "${var.name_prefix}-${var.environment}"
  is_prod  = var.environment == "prod"
  location = var.location

  clickhouse_self_hosted = var.clickhouse_mode == "self_hosted"

  observability_prometheus_enabled = contains(["prometheus", "grafana"], var.observability_stack)
  observability_grafana_enabled    = var.observability_stack == "grafana"

  # VM is needed if ClickHouse, Redis, or bundled Prometheus is self-hosted.
  needs_vm = local.clickhouse_self_hosted || var.redis_mode == "self_hosted" || local.observability_prometheus_enabled

  server_image = "${azurerm_container_registry.main.login_server}/${trimprefix(var.image_repo_server, "ghcr.io/")}:${var.image_tag}"
  auth_image   = "${azurerm_container_registry.main.login_server}/${trimprefix(var.image_repo_auth, "ghcr.io/")}:${var.image_tag}"
  web_image    = "${azurerm_container_registry.main.login_server}/${trimprefix(var.image_repo_web, "ghcr.io/")}:${var.image_tag}"

  # Each Container App is reached at its own FQDN. Derive the URLs from the
  # environment's default domain: the auth app needs its own public URL in
  # its env, which would otherwise be a self-reference cycle through the
  # app's ingress attributes.
  web_url  = "https://${local.name}-web.${azurerm_container_app_environment.main.default_domain}"
  auth_url = "https://${local.name}-auth.${azurerm_container_app_environment.main.default_domain}"
  app_url  = var.domain_name != "" ? "https://${var.domain_name}" : local.web_url

  # Connection strings built from managed resources
  database_url      = "postgresql://${azurerm_postgresql_flexible_server.main.administrator_login}:${random_password.db.result}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/caracal?sslmode=require"
  redis_self_hosted = var.redis_mode == "self_hosted"
  redis_url         = local.redis_self_hosted ? "redis://${azurerm_network_interface.clickhouse[0].private_ip_address}:6379" : "rediss://:${azurerm_redis_enterprise_database.main[0].primary_access_key}@${azurerm_redis_enterprise_cluster.main[0].hostname}:10000"
  clickhouse_url    = local.clickhouse_self_hosted ? "clickhouse://default:${random_password.clickhouse.result}@${azurerm_network_interface.clickhouse[0].private_ip_address}:8123/caracal" : var.clickhouse_cloud_url

  tags = {
    Project     = "caracal"
    Environment = var.environment
    ManagedBy   = "opentofu"
  }
}

resource "terraform_data" "observability_validation" {
  lifecycle {
    precondition {
      condition     = var.observability_stack == "none" || local.clickhouse_self_hosted
      error_message = "Bundled observability requires clickhouse_mode = self_hosted. Use your cloud provider observability stack when ClickHouse Cloud is enabled."
    }
  }
}
