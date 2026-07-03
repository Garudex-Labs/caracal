# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Rendered user data outputs for wiring into VM resources.

output "userData" {
  description = "Rendered cloud-config user data for the VM resource."
  value       = local.userData
}

output "userDataBase64" {
  description = "Base64-encoded user data for providers that require encoded input."
  value       = base64encode(local.userData)
}
