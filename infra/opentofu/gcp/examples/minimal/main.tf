# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

terraform {
  required_version = ">= 1.6.0"
}

module "caracal" {
  source = "../../"

  project_id  = var.project_id
  region      = var.region
  environment = var.environment
  name_prefix = var.name_prefix
  image_tag   = var.image_tag

  domain_name           = var.domain_name
  dns_managed_zone_name = var.dns_managed_zone_name
}
