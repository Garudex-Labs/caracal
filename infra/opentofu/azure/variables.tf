# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

variable "subscription_id" {
  description = "Azure subscription ID."
  type        = string
}

variable "location" {
  description = "Azure region to deploy into."
  type        = string
  default     = "eastus"
}

variable "environment" {
  description = "Environment name (prod or staging). Drives HA toggles, deletion protection, and SKU sizing."
  type        = string
  default     = "staging"
  validation {
    condition     = contains(["prod", "staging"], var.environment)
    error_message = "environment must be 'prod' or 'staging'."
  }
}

variable "name_prefix" {
  description = "Prefix applied to all resource names."
  type        = string
  default     = "caracal"
}

# -- Network -----------------------------------------------------------------

variable "vnet_cidr" {
  description = "CIDR block for the VNet."
  type        = string
  default     = "10.42.0.0/16"
}

variable "subnet_container_apps_cidr" {
  description = "CIDR for the Container Apps subnet (min /23)."
  type        = string
  default     = "10.42.0.0/23"
}

variable "subnet_data_cidr" {
  description = "CIDR for the data tier subnet (PostgreSQL, Redis, ClickHouse VM)."
  type        = string
  default     = "10.42.4.0/24"
}

variable "subnet_vm_cidr" {
  description = "CIDR for the ClickHouse VM subnet."
  type        = string
  default     = "10.42.5.0/24"
}

# -- DNS / TLS ---------------------------------------------------------------

variable "domain_name" {
  description = "Custom domain for the deployment. Leave empty to use Azure-provided URLs."
  type        = string
  default     = ""
}

# -- Container Images --------------------------------------------------------

variable "image_repo_server" {
  description = "Container image repository for the API server + init (they share an image). Mirrored into ACR (see README)."
  type        = string
  default     = "ghcr.io/garudex-labs/caracal-server"
}

variable "image_repo_auth" {
  description = "Container image repository for the identity service. Mirrored into ACR (see README)."
  type        = string
  default     = "ghcr.io/garudex-labs/caracal-auth"
}

variable "image_repo_web" {
  description = "Container image repository for the web frontend. Mirrored into ACR (see README)."
  type        = string
  default     = "ghcr.io/garudex-labs/caracal-web"
}

variable "image_tag" {
  description = "Image tag to deploy. Bump and re-apply to roll out a new release."
  type        = string
  default     = "latest"
}

# -- Container Apps (api / auth / web) -----------------------------------------

variable "api_cpu" {
  description = "CPU cores for the API container (e.g. 0.5, 1, 2)."
  type        = number
  default     = 0.5
}

variable "api_memory" {
  description = "Memory (Gi) for the API container."
  type        = string
  default     = "1Gi"
}

variable "api_min_replicas" {
  description = "Minimum API replicas."
  type        = number
  default     = 2
}

variable "api_max_replicas" {
  description = "Maximum API replicas."
  type        = number
  default     = 10
}

variable "web_cpu" {
  description = "CPU cores for the web container."
  type        = number
  default     = 0.25
}

variable "web_memory" {
  description = "Memory (Gi) for the web container."
  type        = string
  default     = "0.5Gi"
}

variable "web_min_replicas" {
  description = "Minimum web replicas."
  type        = number
  default     = 2
}

variable "web_max_replicas" {
  description = "Maximum web replicas."
  type        = number
  default     = 6
}

variable "auth_cpu" {
  description = "CPU cores for the identity service container."
  type        = number
  default     = 0.25
}

variable "auth_memory" {
  description = "Memory (Gi) for the identity service container."
  type        = string
  default     = "0.5Gi"
}

variable "auth_min_replicas" {
  description = "Minimum identity service replicas."
  type        = number
  default     = 1
}

variable "auth_max_replicas" {
  description = "Maximum identity service replicas."
  type        = number
  default     = 2
}

# -- Data tier (ClickHouse) --------------------------------------------------

variable "clickhouse_mode" {
  description = "Where ClickHouse lives. 'self_hosted' = Azure VM. 'cloud' = ClickHouse Cloud (supply clickhouse_cloud_url + clickhouse_cloud_password)."
  type        = string
  default     = "self_hosted"
  validation {
    condition     = contains(["self_hosted", "cloud"], var.clickhouse_mode)
    error_message = "clickhouse_mode must be 'self_hosted' or 'cloud'."
  }
}

variable "clickhouse_cloud_url" {
  description = "ClickHouse Cloud DSN. Required when clickhouse_mode = 'cloud'."
  type        = string
  default     = ""
  sensitive   = true
}

variable "clickhouse_cloud_password" {
  description = "ClickHouse Cloud password. Required when clickhouse_mode = 'cloud'."
  type        = string
  default     = ""
  sensitive   = true
}

variable "clickhouse_vm_size" {
  description = "Azure VM size for the ClickHouse host."
  type        = string
  default     = "Standard_D2ads_v7"
}

variable "clickhouse_disk_size_gb" {
  description = "Size of the managed disk for ClickHouse data."
  type        = number
  default     = 100
}

# -- Managed data services ---------------------------------------------------

variable "postgresql_sku" {
  description = "PostgreSQL Flexible Server SKU."
  type        = string
  default     = "B_Standard_B2s"
}

variable "postgresql_storage_gb" {
  description = "PostgreSQL storage in GB."
  type        = number
  default     = 64
}

variable "redis_mode" {
  description = "Where Redis lives. 'self_hosted' = on ClickHouse VM via Docker. 'enterprise' = Azure Managed Redis (requires Enterprise quota)."
  type        = string
  default     = "self_hosted"
  validation {
    condition     = contains(["self_hosted", "enterprise"], var.redis_mode)
    error_message = "redis_mode must be 'self_hosted' or 'enterprise'."
  }
}

variable "redis_enterprise_sku" {
  description = "Azure Managed Redis (Enterprise) SKU. Only used when redis_mode = 'enterprise'."
  type        = string
  default     = "Enterprise_E5-2"
}

# -- Observability -----------------------------------------------------------

variable "observability_stack" {
  description = "Bundled observability stack to deploy: none, prometheus, or grafana. grafana includes prometheus."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "prometheus", "grafana"], var.observability_stack)
    error_message = "observability_stack must be one of: none, prometheus, grafana."
  }
}

# -- Application config ------------------------------------------------------


variable "log_retention_days" {
  description = "Log Analytics workspace retention in days."
  type        = number
  default     = 30
}
