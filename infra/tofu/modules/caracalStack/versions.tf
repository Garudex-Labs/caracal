# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Toolchain and provider contract for the caracalStack module. Callers supply
# configured kubernetes and helm providers, keeping the module agnostic to how
# cluster credentials are obtained (kubeconfig, exec plugins, cloud IAM).

terraform {
  required_version = ">= 1.8.0"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.38"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
  }
}
