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

{{- define "caracal.image" -}}
{{- $root := index . "root" -}}
{{- $image := index . "image" -}}
{{- printf "%s/%s:v%s" $root.Values.global.registry $image $root.Values.global.tag -}}
{{- end -}}

{{- define "caracal.secretVolume" -}}
secret:
  secretName: {{ include "caracal.runtimeSecretName" . }}
  items:
    - key: databaseUrl
      path: databaseUrl
    - key: redisUrl
      path: redisUrl
    - key: zoneKek
      path: zoneKek
    - key: auditHmacKey
      path: auditHmacKey
    - key: streamsHmacKey
      path: streamsHmacKey
    - key: gatewayStsHmacKey
      path: gatewayStsHmacKey
    - key: caracalAdminToken
      path: caracalAdminToken
    - key: caracalCoordinatorToken
      path: caracalCoordinatorToken
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
{{- end -}}
{{- end -}}
