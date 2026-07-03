# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Inputs for the production environment. Kubeconfig-based access keeps the
# root portable across EKS, GKE, AKS, and self-hosted clusters; swap the
# provider blocks in main.tf for exec-based auth if your platform requires it.

variable "kubeconfigPath" {
  description = "Path to the kubeconfig used to reach the production cluster."
  type        = string
  default     = "~/.kube/config"
}

variable "kubeContext" {
  description = "Kubeconfig context to use. Empty string uses the current context."
  type        = string
  default     = ""
}

variable "namespace" {
  description = "Namespace for the production stack."
  type        = string
  default     = "caracal"
}

variable "chartVersion" {
  description = "Released chart version to deploy. Production always pins a published artifact."
  type        = string

  validation {
    condition     = length(var.chartVersion) > 0
    error_message = "chartVersion must pin a released chart version."
  }
}

variable "databaseHost" {
  description = "Externally managed HA PostgreSQL host. The chart's stable-mode guardrails reject in-cluster defaults."
  type        = string
}

variable "redisHost" {
  description = "Externally managed HA Redis host. The chart's stable-mode guardrails reject in-cluster defaults."
  type        = string
}

variable "imagePullSecretNames" {
  description = "Names of pre-provisioned registry pull Secrets, for private mirrors of the Caracal images."
  type        = list(string)
  default     = []
}

variable "extraValues" {
  description = "Additional raw YAML values documents (ingress hosts, web publicUrl, observability endpoints)."
  type        = list(string)
  default     = []
}
