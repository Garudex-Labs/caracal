# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

output "app_url" {
  description = "Caracal application URL."
  value       = module.caracal.app_url
}

output "alb_dns_name" {
  description = "ALB DNS name."
  value       = module.caracal.alb_dns_name
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.caracal.ecs_cluster_name
}
