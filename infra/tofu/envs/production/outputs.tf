# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Production environment outputs.

output "namespace" {
  description = "Namespace the production stack is installed into."
  value       = module.caracal.namespace
}

output "releaseVersion" {
  description = "Deployed chart version."
  value       = module.caracal.releaseVersion
}

output "releaseStatus" {
  description = "Helm release status after apply."
  value       = module.caracal.releaseStatus
}
