# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Production environment: installs a pinned released chart from the OCI
# registry with the stable values profile. Runtime credentials are never
# provisioned here; deliver the caracal-runtime Secret with your secret
# manager (e.g. External Secrets Operator) before the first apply. The
# chart's values.production.yaml stays the single source of stable defaults.

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

  namespace    = var.namespace
  chartVersion = var.chartVersion
  mode         = "stable"
  evaluation   = false

  values = concat(
    [
      file("${path.module}/../../../helm/caracal/values.production.yaml"),
      yamlencode({
        global = {
          imagePullSecrets = [for name in var.imagePullSecretNames : { name = name }]
        }
        secrets = {
          database = { host = var.databaseHost }
          redis    = { host = var.redisHost }
        }
      }),
    ],
    var.extraValues,
  )
}
