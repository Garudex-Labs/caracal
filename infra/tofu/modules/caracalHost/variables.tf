# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Input surface for the caracalHost module. The release version is the only
# required input; secrets are generated on the host at first start and never
# pass through OpenTofu state.

variable "caracalVersion" {
  description = "Caracal release version to install, as a release tag."
  type        = string

  validation {
    condition     = can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$", var.caracalVersion))
    error_message = "caracalVersion must be a release tag like v0.2.0 or v0.2.0-rc.1."
  }
}

variable "caracalHome" {
  description = "Runtime home on the host holding compose assets, operator overrides, and generated secrets."
  type        = string
  default     = "/var/lib/caracal"
}

variable "installScriptUrl" {
  description = "Optional HTTPS installer mirror. Null resolves the installer from the selected immutable release tag, never main."
  type        = string
  default     = null

  validation {
    condition     = var.installScriptUrl == null || can(regex("^https://", var.installScriptUrl))
    error_message = "installScriptUrl must be null or an HTTPS URL."
  }
}

variable "requireProvenance" {
  description = "Require GitHub attestation verification during install. Needs the gh CLI on the image; archive checksums are verified either way."
  type        = bool
  default     = false
}

variable "envOverrides" {
  description = "Operator overrides written to caracal.env before first start. Non-secret configuration only; secret material belongs in the host secrets directory."
  type        = map(string)
  default     = {}
}

variable "operatorEmails" {
  description = "Console operators admitted at first boot. Exact addresses or @domain suffixes, written to the sign-in allowlist before the stack starts. Empty means admission is managed after boot with 'caracal allowlist'."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for entry in var.operatorEmails : can(regex("^(@|[^@]+@)[A-Za-z0-9.-]+$", entry))])
    error_message = "operatorEmails entries must be email addresses or @domain suffixes."
  }
}

variable "extraRuncmd" {
  description = "Additional shell commands run after the CLI install and before stack start, such as reverse proxy or monitoring agent setup."
  type        = list(string)
  default     = []
}

variable "tlsProxy" {
  description = "Optional TLS reverse proxy with automatic certificates. The packaged stack publishes every port on loopback only, so without a proxy the host serves no external traffic. Routes map a public hostname to the Caracal service behind it, and the console origin and token issuer are derived from them."
  type = object({
    email  = string
    routes = map(string)
  })
  default = null

  validation {
    condition = var.tlsProxy == null || alltrue([
      for service in values(var.tlsProxy.routes) : contains(["web", "api", "sts", "gateway"], service)
    ])
    error_message = "tlsProxy.routes values must each be one of: web, api, sts, gateway."
  }

  validation {
    condition     = var.tlsProxy == null || length(var.tlsProxy.routes) > 0
    error_message = "tlsProxy.routes must map at least one public hostname to a service."
  }
}

variable "proxyImage" {
  description = "Reverse proxy image used when tlsProxy is set. Pinned by digest so a host rebuilt later runs the same proxy."
  type        = string
  default     = "caddy:2-alpine@sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a"
}
