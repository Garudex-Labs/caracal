# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

output "app_url" {
  description = "Public URL for the Caracal install."
  value       = module.caracal.app_url
}

output "ecs_cluster_name" {
  value = module.caracal.ecs_cluster_name
}

output "data_host_ssm_session_command" {
  description = "Open a shell on the data tier host."
  value       = module.caracal.data_host_ssm_session_command
}

output "init_run_task_command" {
  description = "Re-run the migrations/seed task."
  value       = module.caracal.init_run_task_command
}
