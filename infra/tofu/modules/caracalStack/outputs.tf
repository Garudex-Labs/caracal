# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Observable results of a caracalStack install for wiring into DNS, ingress,
# or downstream automation.

output "namespace" {
  description = "Namespace the stack is installed into."
  value       = var.namespace
}

output "releaseName" {
  description = "Helm release name."
  value       = helm_release.caracal.name
}

output "releaseVersion" {
  description = "Deployed chart version."
  value       = helm_release.caracal.version
}

output "releaseStatus" {
  description = "Helm release status after apply."
  value       = helm_release.caracal.status
}
