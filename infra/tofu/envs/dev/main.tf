# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Dev environment: installs the working-tree chart with the dev values profile
# so infrastructure changes are exercised before any artifact is published.
# The chart's values.dev.yaml stays the single source of dev defaults.

provider "kubernetes" {
  config_path    = pathexpand(var.kubeconfigPath)
  config_context = var.kubeContext != "" ? var.kubeContext : null
}

provider "helm" {
  kubernetes = {
    config_path    = pathexpand(var.kubeconfigPath)
    config_context = var.kubeContext != "" ? var.kubeContext : null
  }
}

module "caracal" {
  source = "../../modules/caracalStack"

  namespace       = var.namespace
  chartRepository = ""
  chartName       = "${path.module}/../../../helm/caracal"
  mode            = "dev"
  evaluation      = true
  runtimeSecrets  = var.runtimeSecrets

  values = [
    file("${path.module}/../../../helm/caracal/values.dev.yaml"),
  ]
}
