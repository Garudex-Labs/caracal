# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Provisions one Caracal stack: a pod-security-restricted namespace, optional
# externally managed runtime credentials, and the Helm release itself. The
# chart owns all workload topology; this module only anchors it in a cluster.

locals {
  # Mode and evaluation flags travel through IaC so an environment cannot
  # silently drift from its declared posture between applies.
  baseValues = {
    global = {
      mode       = var.mode
      evaluation = var.evaluation
    }
    secrets = {
      runtimeSecretName = var.runtimeSecretName
    }
  }
}

resource "kubernetes_namespace_v1" "caracal" {
  count = var.createNamespace ? 1 : 0

  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/managed-by"       = "opentofu"
      "pod-security.kubernetes.io/enforce" = "restricted"
      "pod-security.kubernetes.io/audit"   = "restricted"
      "pod-security.kubernetes.io/warn"    = "restricted"
    }
  }
}

resource "kubernetes_secret_v1" "runtime" {
  count = length(var.runtimeSecrets) > 0 ? 1 : 0

  metadata {
    name      = var.runtimeSecretName
    namespace = var.namespace
    labels = {
      "app.kubernetes.io/managed-by" = "opentofu"
      "app.kubernetes.io/part-of"    = "caracal"
    }
  }

  type = "Opaque"
  data = var.runtimeSecrets

  depends_on = [kubernetes_namespace_v1.caracal]
}

resource "helm_release" "caracal" {
  name       = var.releaseName
  repository = var.chartRepository != "" ? var.chartRepository : null
  chart      = var.chartName
  version    = var.chartVersion != "" ? var.chartVersion : null
  namespace  = var.namespace

  create_namespace = false
  atomic           = var.atomic
  wait             = true
  wait_for_jobs    = true
  timeout          = var.timeoutSeconds

  values = concat([yamlencode(local.baseValues)], var.values)

  set = [
    for name, value in var.setValues : {
      name  = name
      value = value
    }
  ]

  depends_on = [
    kubernetes_namespace_v1.caracal,
    kubernetes_secret_v1.runtime,
  ]
}
