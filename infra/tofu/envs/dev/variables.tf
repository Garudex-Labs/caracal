# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Inputs for the dev environment. Cluster access is kubeconfig-based so any
# local or disposable cluster (kind, k3d, minikube, cloud sandbox) works.

variable "kubeconfigPath" {
  description = "Path to the kubeconfig used to reach the dev cluster."
  type        = string
  default     = "~/.kube/config"
}

variable "kubeContext" {
  description = "Kubeconfig context to use. Empty string uses the current context."
  type        = string
  default     = ""
}

variable "namespace" {
  description = "Namespace for the dev stack."
  type        = string
  default     = "caracal"
}

variable "runtimeSecrets" {
  description = "Runtime credential material for the dev stack. Generate throwaway values; never reuse production credentials."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "values" {
  description = "Additional Helm values documents applied after the dev profile, for disposable cluster-specific settings."
  type        = list(string)
  default     = []
}

variable "setValues" {
  description = "Final chart overrides, including locally loaded image registry and tag for source verification."
  type        = map(string)
  default     = {}
}
