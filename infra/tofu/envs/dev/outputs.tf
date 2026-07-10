# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Dev environment outputs.

output "namespace" {
  description = "Namespace the dev stack is installed into."
  value       = module.caracal.namespace
}

output "releaseStatus" {
  description = "Helm release status after apply."
  value       = module.caracal.releaseStatus
}
