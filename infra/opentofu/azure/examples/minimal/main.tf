# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

# Minimal example: deploy Caracal to Azure with defaults.

module "caracal" {
  source = "../../"

  subscription_id = "6a0284fc-791a-4d77-9520-69cdaa79ba44"
  environment     = "staging"
  location        = "eastus"
}

output "api_url" {
  value = module.caracal.api_url
}

output "web_url" {
  value = module.caracal.web_url
}
