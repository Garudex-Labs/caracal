# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.caracal.id
}

output "public_ip" {
  description = "Elastic IP address"
  value       = aws_eip.caracal.public_ip
}

output "url" {
  description = "Site URL"
  value       = var.domain != "" ? "https://${var.domain}" : "http://${aws_eip.caracal.public_ip}"
}

output "ssm_command" {
  description = "Command to connect via SSM"
  value       = "aws ssm start-session --target ${aws_instance.caracal.id} --region ${var.region}"
}

output "region" {
  description = "AWS region"
  value       = var.region
}

output "domain" {
  description = "Configured domain (empty if IP-only)"
  value       = var.domain
}

output "caracal_ref" {
  description = "Git ref being deployed"
  value       = var.caracal_ref
}

output "env_overrides" {
  description = "Environment overrides (for deploy.sh)"
  value       = var.env_overrides
  sensitive   = true
}

output "observability_stack" {
  description = "Bundled observability stack"
  value       = var.observability_stack
}

output "caracal_repo" {
  description = "Git repository URL"
  value       = var.caracal_repo
}

output "image_tag" {
  description = "Caracal image tag being deployed"
  value       = var.image_tag
}
