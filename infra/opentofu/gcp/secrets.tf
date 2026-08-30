# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

resource "random_password" "secret_key" {
  length  = 64
  special = false
}

resource "random_password" "clickhouse" {
  length  = 32
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

locals {
  secrets = {
    DATABASE_URL         = local.database_url
    REDIS_URL            = local.redis_url
    SECRET_KEY           = random_password.secret_key.result
    CLICKHOUSE_URL       = local.clickhouse_url
    AUTH_INTERNAL_SECRET = random_password.auth_internal_secret.result
    BETTER_AUTH_SECRET   = random_password.better_auth_secret.result
  }
}

resource "google_secret_manager_secret" "app" {
  for_each  = local.secrets
  secret_id = "${local.name}-${lower(replace(each.key, "_", "-"))}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "app" {
  for_each    = local.secrets
  secret      = google_secret_manager_secret.app[each.key].id
  secret_data = coalesce(each.value, " ")
}

resource "google_secret_manager_secret_iam_member" "cloud_run_access" {
  for_each  = local.secrets
  secret_id = google_secret_manager_secret.app[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run.email}"
}
