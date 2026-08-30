# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

# Container Apps Environment with VNet integration
resource "azurerm_container_app_environment" "main" {
  name                       = "${local.name}-env"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id   = azurerm_subnet.container_apps.id

  tags = local.tags

  depends_on = [
    azurerm_subnet.container_apps,
    azurerm_virtual_network.main,
  ]
}

# -- API service -------------------------------------------------------------

resource "azurerm_container_app" "api" {
  name                         = "${local.name}-api"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }

  secret {
    name  = "database-url"
    value = local.database_url
  }

  secret {
    name  = "redis-url"
    value = local.redis_url
  }

  secret {
    name  = "clickhouse-url"
    value = local.clickhouse_url
  }

  secret {
    name  = "secret-key"
    value = random_password.secret_key.result
  }

  secret {
    name  = "auth-internal-secret"
    value = random_password.auth_internal_secret.result
  }

  template {
    min_replicas = var.api_min_replicas
    max_replicas = var.api_max_replicas

    container {
      name   = "api"
      image  = local.server_image
      cpu    = var.api_cpu
      memory = var.api_memory

      # No command override: the image default runs the API server on port 8080.

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
        name        = "CARACAL_POSTGRES_URL"
        secret_name = "database-url"
      }

      env {
        name        = "CARACAL_REDIS_URL"
        secret_name = "redis-url"
      }

      env {
        name        = "CARACAL_CLICKHOUSE_URL"
        secret_name = "clickhouse-url"
      }

      env {
        name        = "SECRET_KEY"
        secret_name = "secret-key"
      }

      env {
        name        = "AUTH_INTERNAL_SECRET"
        secret_name = "auth-internal-secret"
      }

      liveness_probe {
        transport = "HTTP"
        path      = "/health"
        port      = 8080
      }

      readiness_probe {
        transport = "HTTP"
        path      = "/health"
        port      = 8080
      }

      startup_probe {
        transport               = "HTTP"
        path                    = "/health"
        port                    = 8080
        failure_count_threshold = 10
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = 8080
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  tags = local.tags
}

# -- Auth service (identity) ---------------------------------------------------

resource "azurerm_container_app" "auth" {
  name                         = "${local.name}-auth"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }

  secret {
    name  = "database-url"
    value = local.database_url
  }

  secret {
    name  = "better-auth-secret"
    value = random_password.better_auth_secret.result
  }

  secret {
    name  = "auth-internal-secret"
    value = random_password.auth_internal_secret.result
  }

  template {
    min_replicas = var.auth_min_replicas
    max_replicas = var.auth_max_replicas

    container {
      name   = "auth"
      image  = local.auth_image
      cpu    = var.auth_cpu
      memory = var.auth_memory

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
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }

      env {
        name        = "BETTER_AUTH_SECRET"
        secret_name = "better-auth-secret"
      }

      env {
        name        = "AUTH_INTERNAL_SECRET"
        secret_name = "auth-internal-secret"
      }

      liveness_probe {
        transport = "HTTP"
        path      = "/healthz"
        port      = 3001
      }

      readiness_probe {
        transport = "HTTP"
        path      = "/healthz"
        port      = 3001
      }

      startup_probe {
        transport               = "HTTP"
        path                    = "/healthz"
        port                    = 3001
        failure_count_threshold = 10
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3001
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  tags = local.tags
}

# -- Web service -------------------------------------------------------------

resource "azurerm_container_app" "web" {
  name                         = "${local.name}-web"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }

  template {
    min_replicas = var.web_min_replicas
    max_replicas = var.web_max_replicas

    container {
      name   = "web"
      image  = local.web_image
      cpu    = var.web_cpu
      memory = var.web_memory

      liveness_probe {
        transport = "HTTP"
        path      = "/"
        port      = 8000
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = 8000
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  tags = local.tags
}

# -- Init job (Postgres + ClickHouse migrations) -------------------------------

resource "azurerm_container_app_job" "init" {
  name                         = "${local.name}-init"
  location                     = azurerm_resource_group.main.location
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  replica_timeout_in_seconds   = 600
  replica_retry_limit          = 1

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }

  secret {
    name  = "database-url"
    value = local.database_url
  }

  secret {
    name  = "redis-url"
    value = local.redis_url
  }

  secret {
    name  = "clickhouse-url"
    value = local.clickhouse_url
  }

  secret {
    name  = "secret-key"
    value = random_password.secret_key.result
  }

  secret {
    name  = "auth-internal-secret"
    value = random_password.auth_internal_secret.result
  }

  template {
    container {
      name   = "init"
      image  = local.server_image
      cpu    = 0.5
      memory = "1Gi"

      # One-shot: the image entrypoint with "init" applies Postgres +
      # ClickHouse migrations and exits.
      args = ["init"]

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
        name        = "CARACAL_POSTGRES_URL"
        secret_name = "database-url"
      }

      env {
        name        = "CARACAL_REDIS_URL"
        secret_name = "redis-url"
      }

      env {
        name        = "CARACAL_CLICKHOUSE_URL"
        secret_name = "clickhouse-url"
      }

      env {
        name        = "SECRET_KEY"
        secret_name = "secret-key"
      }

      env {
        name        = "AUTH_INTERNAL_SECRET"
        secret_name = "auth-internal-secret"
      }
    }
  }

  tags = local.tags
}
