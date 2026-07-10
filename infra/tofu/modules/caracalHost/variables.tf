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
  description = "URL of the Caracal installer script. Point at an internal mirror for air-gapped or egress-restricted networks."
  type        = string
  default     = "https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install.sh"
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

variable "extraRuncmd" {
  description = "Additional shell commands run after the CLI install and before stack start, such as reverse proxy or monitoring agent setup."
  type        = list(string)
  default     = []
}
