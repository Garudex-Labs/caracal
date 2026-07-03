# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Input surface for the caracalStack module. Chart profile files remain the
# single source of deployment defaults; these variables only wire environment
# identity, chart provenance, and externally managed secret material.

variable "namespace" {
  description = "Kubernetes namespace the Caracal stack is installed into."
  type        = string
  default     = "caracal"
}

variable "createNamespace" {
  description = "Create and label the namespace. Disable when a platform team owns namespace lifecycle."
  type        = bool
  default     = true
}

variable "releaseName" {
  description = "Helm release name."
  type        = string
  default     = "caracal"
}

variable "chartRepository" {
  description = "Chart repository URL. Use the OCI registry for released versions, or empty string to treat chartName as a local chart path."
  type        = string
  default     = "oci://ghcr.io/garudex-labs/charts"
}

variable "chartName" {
  description = "Chart name in the repository, or a local chart directory path when chartRepository is empty."
  type        = string
  default     = "caracal"
}

variable "chartVersion" {
  description = "Pinned chart version. Empty string uses the chart's own version (local path installs only)."
  type        = string
  default     = ""
}

variable "mode" {
  description = "Deployment mode passed to the chart; stable enables the chart's production guardrails."
  type        = string
  default     = "rc"

  validation {
    condition     = contains(["dev", "rc", "stable"], var.mode)
    error_message = "mode must be one of: dev, rc, stable."
  }
}

variable "evaluation" {
  description = "Acknowledge evaluation-grade posture (permits chart-managed plaintext secrets)."
  type        = bool
  default     = false
}

variable "runtimeSecretName" {
  description = "Name of the runtime credentials Secret consumed by the chart."
  type        = string
  default     = "caracal-runtime"
}

variable "runtimeSecrets" {
  description = "Runtime credential material to provision as the runtime Secret. Leave empty when the Secret is delivered by an external secret manager (e.g. External Secrets Operator)."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "values" {
  description = "Raw YAML values documents merged into the release, in ascending precedence."
  type        = list(string)
  default     = []
}

variable "setValues" {
  description = "Individual chart value overrides applied after all values documents."
  type        = map(string)
  default     = {}
}

variable "atomic" {
  description = "Roll back automatically when an install or upgrade fails."
  type        = bool
  default     = true
}

variable "timeoutSeconds" {
  description = "Upper bound for install and upgrade operations, including migration hook Jobs."
  type        = number
  default     = 900
}
