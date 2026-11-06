# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Renders provider-agnostic cloud-init user data that installs Docker and the
# Caracal runtime CLI on first boot, then starts the pinned stack. Attach the
# output to any VM resource's user data field; the host generates its own
# runtime secrets so no credential material transits OpenTofu state.

locals {
  # Loopback ports the packaged Compose stack publishes on the host.
  servicePorts = {
    web     = 3001
    api     = 3000
    sts     = 8080
    gateway = 8081
  }

  proxyEnabled = var.tlsProxy != null
  proxyRoutes  = local.proxyEnabled ? var.tlsProxy.routes : {}

  proxyWebHost = one([for host, service in local.proxyRoutes : host if service == "web"])
  proxyStsHost = one([for host, service in local.proxyRoutes : host if service == "sts"])

  # The console origin and the token issuer must match the names the proxy
  # terminates, so they are derived from the routes instead of being restated in
  # envOverrides where the two could drift apart.
  proxyEnv = local.proxyEnabled ? merge(
    { CARACAL_AUTH_TRUST_PROXY = "1" },
    local.proxyWebHost == null ? {} : {
      CARACAL_WEB_URL    = "https://${local.proxyWebHost}"
      CARACAL_WEB_ORIGIN = "https://${local.proxyWebHost}"
    },
    local.proxyStsHost == null ? {} : {
      CARACAL_STS_ISSUER_URL = "https://${local.proxyStsHost}"
    },
  ) : {}

  hostEnv  = merge({ CARACAL_REQUIRE_SIGN_IN_METHOD = "1" }, local.proxyEnv, var.envOverrides)
  envLines = [for key in sort(keys(local.hostEnv)) : "${key}=${local.hostEnv[key]}"]

  caddyfile = local.proxyEnabled ? join("\n", concat(
    ["{", "\temail ${var.tlsProxy.email}", "}"],
    flatten([for host in sort(keys(local.proxyRoutes)) : [
      "${host} {",
      "\treverse_proxy 127.0.0.1:${local.servicePorts[local.proxyRoutes[host]]}",
      "}",
    ]]),
  )) : ""

  userData = templatefile("${path.module}/templates/userData.yaml.tftpl", {
    caracalVersion    = var.caracalVersion
    caracalHome       = var.caracalHome
    installScriptUrl  = coalesce(var.installScriptUrl, "https://raw.githubusercontent.com/Garudex-Labs/caracal/${var.caracalVersion}/install.sh")
    requireProvenance = var.requireProvenance
    envLines          = local.envLines
    operatorEmails    = var.operatorEmails
    extraRuncmd       = var.extraRuncmd
    caddyfile         = local.caddyfile
    proxyImage        = var.proxyImage
  })
}
