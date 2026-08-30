# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

resource "google_service_account" "cloud_run" {
  account_id   = "${var.name_prefix}-run"
  display_name = "Caracal Cloud Run service account"

  depends_on = [google_project_service.iam]
}

resource "google_project_iam_member" "cloud_run_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.cloud_run.email}"
}

resource "google_project_iam_member" "cloud_run_trace_writer" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.cloud_run.email}"
}

# ── API service ───────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "api" {
  name     = "${local.name}-api"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  depends_on = [google_project_service.run]

  template {
    service_account = google_service_account.cloud_run.email

    vpc_access {
      connector = google_vpc_access_connector.main.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }

    containers {
      # No args: the image default runs the API server on port 8080.
      image = local.image_server

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.api_cpu
          memory = var.api_memory
        }
      }

      env {
        name  = "CARACAL_JWKS_URL"
        value = "${local.auth_url}/api/auth/jwks"
      }

      env {
        name  = "CARACAL_JWT_ISSUER"
        value = local.auth_url
      }

      env {
        name  = "CARACAL_JWT_AUDIENCE"
        value = "caracal-api"
      }

      env {
        name  = "CARACAL_AUTH_SERVICE_URL"
        value = local.auth_url
      }

      env {
        name = "CARACAL_POSTGRES_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["DATABASE_URL"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "CARACAL_REDIS_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["REDIS_URL"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "CARACAL_CLICKHOUSE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["CLICKHOUSE_URL"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "SECRET_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["SECRET_KEY"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "AUTH_INTERNAL_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["AUTH_INTERNAL_SECRET"].secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 10
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        period_seconds    = 15
        failure_threshold = 3
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "api_public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── Web service ───────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "web" {
  name     = "${local.name}-web"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.cloud_run.email

    scaling {
      min_instance_count = var.web_min_instances
      max_instance_count = var.web_max_instances
    }

    containers {
      image = local.image_web

      ports {
        container_port = 8000
      }

      resources {
        limits = {
          cpu    = var.web_cpu
          memory = var.web_memory
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  name     = google_cloud_run_v2_service.web.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── Auth service (identity) ───────────────────────────────────────────────

resource "google_cloud_run_v2_service" "auth" {
  name     = "${local.name}-auth"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  depends_on = [google_project_service.run]

  template {
    service_account = google_service_account.cloud_run.email

    vpc_access {
      connector = google_vpc_access_connector.main.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    scaling {
      min_instance_count = var.auth_min_instances
      max_instance_count = var.auth_max_instances
    }

    containers {
      image = local.image_auth

      ports {
        container_port = 3001
      }

      resources {
        limits = {
          cpu    = var.auth_cpu
          memory = var.auth_memory
        }
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "AUTH_PORT"
        value = "3001"
      }

      env {
        name  = "BETTER_AUTH_URL"
        value = local.auth_url
      }

      env {
        name  = "AUTH_TRUSTED_ORIGINS"
        value = local.app_url
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["DATABASE_URL"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "BETTER_AUTH_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["BETTER_AUTH_SECRET"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "AUTH_INTERNAL_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["AUTH_INTERNAL_SECRET"].secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
          port = 3001
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 10
      }

      liveness_probe {
        http_get {
          path = "/healthz"
          port = 3001
        }
        period_seconds    = 15
        failure_threshold = 3
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "auth_public" {
  name     = google_cloud_run_v2_service.auth.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── Init job (Postgres + ClickHouse migrations) ────────────────────────────

resource "google_cloud_run_v2_job" "init" {
  name     = "${local.name}-init"
  location = var.region

  template {
    template {
      service_account = google_service_account.cloud_run.email

      vpc_access {
        connector = google_vpc_access_connector.main.id
        egress    = "PRIVATE_RANGES_ONLY"
      }

      max_retries = 1
      timeout     = "300s"

      containers {
        image = local.image_server
        args  = ["init"]

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        env {
          name  = "CARACAL_JWKS_URL"
          value = "${local.auth_url}/api/auth/jwks"
        }

        env {
          name  = "CARACAL_JWT_ISSUER"
          value = local.auth_url
        }

        env {
          name  = "CARACAL_JWT_AUDIENCE"
          value = "caracal-api"
        }

        env {
          name  = "CARACAL_AUTH_SERVICE_URL"
          value = local.auth_url
        }

        env {
          name = "CARACAL_POSTGRES_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["DATABASE_URL"].secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "CARACAL_REDIS_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["REDIS_URL"].secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "CARACAL_CLICKHOUSE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["CLICKHOUSE_URL"].secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "SECRET_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["SECRET_KEY"].secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "AUTH_INTERNAL_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["AUTH_INTERNAL_SECRET"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
}
