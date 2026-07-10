{{/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Shared Helm template helpers for the Caracal Kubernetes deployment.
*/}}

{{- define "caracal.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "caracal.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "caracal.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "caracal.labels" -}}
app.kubernetes.io/name: {{ include "caracal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: caracal
{{- end -}}

{{- define "caracal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "caracal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "caracal.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "caracal.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "caracal.runtimeSecretName" -}}
{{- .Values.secrets.runtimeSecretName -}}
{{- end -}}

{{- define "caracal.stsAdminTokenSecretName" -}}
{{- if .Values.secrets.stsAdminToken.secretName -}}
{{- .Values.secrets.stsAdminToken.secretName -}}
{{- else if and .Values.secrets.create .Values.secrets.plaintext.stsAdminToken -}}
{{- include "caracal.runtimeSecretName" . -}}
{{- end -}}
{{- end -}}

{{- define "caracal.auditAdminTokenSecretName" -}}
{{- if .Values.secrets.auditAdminToken.secretName -}}
{{- .Values.secrets.auditAdminToken.secretName -}}
{{- else if and .Values.secrets.create .Values.secrets.plaintext.auditAdminToken -}}
{{- include "caracal.runtimeSecretName" . -}}
{{- end -}}
{{- end -}}

{{- define "caracal.metricsBearerSecretName" -}}
{{- if .Values.secrets.metricsBearer.secretName -}}
{{- .Values.secrets.metricsBearer.secretName -}}
{{- else if and .Values.secrets.create .Values.secrets.plaintext.metricsBearer -}}
{{- include "caracal.runtimeSecretName" . -}}
{{- end -}}
{{- end -}}

{{- define "caracal.image" -}}
{{- $root := index . "root" -}}
{{- $image := index . "image" -}}
{{- printf "%s/%s:v%s" $root.Values.global.registry $image (default $root.Chart.AppVersion $root.Values.global.tag) -}}
{{- end -}}

{{- define "caracal.serviceUrl" -}}
{{- $root := index . "root" -}}
{{- $name := index . "name" -}}
{{- $service := index $root.Values.services $name -}}
{{- default (printf "http://%s-%s:%v" (include "caracal.fullname" $root) $name $service.port) $service.internalUrl -}}
{{- end -}}

{{- define "caracal.secretVolume" -}}
{{- $root := index . "root" -}}
{{- $name := index . "name" -}}
secret:
  secretName: {{ include "caracal.runtimeSecretName" $root }}
  items:
    - key: {{ $name }}DatabaseUrl
      path: {{ $name }}DatabaseUrl
    - key: redisUrl
      path: redisUrl
    {{- if or (eq $name "api") (eq $name "sts") }}
    - key: secretStoreKek
      path: secretStoreKek
    {{- if $root.Values.secrets.kekRotation }}
    - key: secretStoreKekPrevious
      path: secretStoreKekPrevious
    {{- end }}
    {{- end }}
    - key: auditHmacKey
      path: auditHmacKey
    {{- if ne $name "audit" }}
    - key: streamsHmacKey
      path: streamsHmacKey
    {{- end }}
    {{- if eq $name "coordinator" }}
    - key: idempotencyHmacKey
      path: idempotencyHmacKey
    {{- end }}
    {{- if or (eq $name "api") (eq $name "sts") (eq $name "gateway") }}
    - key: gatewayStsHmacKey
      path: gatewayStsHmacKey
    {{- end }}
    {{- if or (eq $name "api") (eq $name "gateway") }}
    - key: caracalAdminToken
      path: caracalAdminToken
    {{- end }}
    {{- if eq $name "coordinator" }}
    - key: caracalCoordinatorToken
      path: caracalCoordinatorToken
    {{- end }}
    {{- if not (include "caracal.metricsBearerSecretName" $root) }}
    - key: metricsBearer
      path: metricsBearer
    {{- end }}
{{- end -}}

{{- define "caracal.validateProduction" -}}
{{- if eq .Values.global.mode "stable" -}}
{{- if .Values.secrets.create -}}
{{- fail "secrets.create=true is forbidden when global.mode=stable; use an operator-managed Secret" -}}
{{- end -}}
{{- if eq .Values.secrets.database.host "postgres.default.svc.cluster.local" -}}
{{- fail "stable deployments must set secrets.database.host to an externally managed HA Postgres endpoint" -}}
{{- end -}}
{{- if eq .Values.secrets.redis.host "redis.default.svc.cluster.local" -}}
{{- fail "stable deployments must set secrets.redis.host to an externally managed HA Redis endpoint" -}}
{{- end -}}
{{- if and .Values.networkPolicy.enabled (not .Values.networkPolicy.allowOpenDns) (empty .Values.networkPolicy.dnsEgress) -}}
{{- fail "stable deployments with NetworkPolicy enabled must configure networkPolicy.dnsEgress or explicitly set networkPolicy.allowOpenDns=true" -}}
{{- end -}}
{{- $externalIngress := or .Values.ingress.sts.enabled .Values.ingress.gateway.enabled .Values.ingress.api.enabled .Values.ingress.web.enabled -}}
{{- if and .Values.networkPolicy.enabled $externalIngress (empty .Values.networkPolicy.extraIngress) -}}
{{- fail "stable deployments with Ingress enabled must configure networkPolicy.extraIngress for the ingress controller" -}}
{{- end -}}
{{- end -}}
{{- end -}}
