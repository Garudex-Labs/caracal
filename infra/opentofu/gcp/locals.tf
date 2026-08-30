# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

data "google_project" "current" {
  project_id = var.project_id
}

locals {
  name = "${var.name_prefix}-${var.environment}"

  enable_custom_domain = var.domain_name != "" && var.dns_managed_zone_name != ""

  # With a custom domain the global LB serves web, api, and auth from one
  # origin. Without one, each Cloud Run service has its own URL: the app is
  # reached at the web service URL and the identity service at its own URL.
  app_url = local.enable_custom_domain ? "https://${var.domain_name}" : google_cloud_run_v2_service.web.uri

  # The auth service needs its own public URL in its env (BETTER_AUTH_URL),
  # which would be a self-reference cycle through .uri - use Cloud Run's
  # deterministic URL format instead.
  auth_url = local.enable_custom_domain ? "https://${var.domain_name}" : "https://${local.name}-auth-${data.google_project.current.number}.${var.region}.run.app"

  clickhouse_self_hosted = var.clickhouse_mode == "self_hosted"

  observability_prometheus_enabled = contains(["prometheus", "grafana"], var.observability_stack)
  observability_grafana_enabled    = var.observability_stack == "grafana"

  ar_prefix = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.ghcr_proxy.repository_id}"

  image_repo_server_effective = trimprefix(var.image_repo_server, "ghcr.io/")
  image_repo_auth_effective   = trimprefix(var.image_repo_auth, "ghcr.io/")
  image_repo_web_effective    = trimprefix(var.image_repo_web, "ghcr.io/")

  image_server = "${local.ar_prefix}/${local.image_repo_server_effective}:${var.image_tag}"
  image_auth   = "${local.ar_prefix}/${local.image_repo_auth_effective}:${var.image_tag}"
  image_web    = "${local.ar_prefix}/${local.image_repo_web_effective}:${var.image_tag}"

  database_url   = "postgresql://${google_sql_user.app.name}:${random_password.db.result}@${google_sql_database_instance.postgres.private_ip_address}:5432/${google_sql_database.app.name}"
  redis_url      = "redis://${google_redis_instance.main.host}:${google_redis_instance.main.port}"
  clickhouse_url = local.clickhouse_self_hosted ? "clickhouse://default:${random_password.clickhouse.result}@${google_compute_instance.data_host[0].network_interface[0].network_ip}:8123/caracal" : var.clickhouse_cloud_url
}

resource "terraform_data" "observability_validation" {
  lifecycle {
    precondition {
      condition     = var.observability_stack == "none" || local.clickhouse_self_hosted
      error_message = "Bundled observability requires clickhouse_mode = self_hosted. Use your cloud provider observability stack when ClickHouse Cloud is enabled."
    }
  }
}
