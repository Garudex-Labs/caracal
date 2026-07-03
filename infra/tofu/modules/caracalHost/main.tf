# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Renders provider-agnostic cloud-init user data that installs Docker and the
# Caracal runtime CLI on first boot, then starts the pinned stack. Attach the
# output to any VM resource's user data field; the host generates its own
# runtime secrets so no credential material transits OpenTofu state.

locals {
  envLines = [for key in sort(keys(var.envOverrides)) : "${key}=${var.envOverrides[key]}"]

  userData = templatefile("${path.module}/templates/userData.yaml.tftpl", {
    caracalVersion    = var.caracalVersion
    caracalHome       = var.caracalHome
    installScriptUrl  = var.installScriptUrl
    requireProvenance = var.requireProvenance
    envLines          = local.envLines
    extraRuncmd       = var.extraRuncmd
  })
}
