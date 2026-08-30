# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

output "app_url" {
  value = module.caracal.app_url
}

output "cloud_run_urls" {
  value = module.caracal.cloud_run_urls
}

output "init_job_run_command" {
  value = module.caracal.init_job_run_command
}

output "data_host_ssh_command" {
  value = module.caracal.data_host_ssh_command
}
