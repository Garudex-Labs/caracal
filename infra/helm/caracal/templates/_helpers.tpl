{{/*
SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
SPDX-License-Identifier: Apache-2.0
*/}}

{{/*
Expand the name of the chart.
*/}}
{{- define "caracal.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "caracal.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart label.
*/}}
{{- define "caracal.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to all resources.
*/}}
{{- define "caracal.labels" -}}
helm.sh/chart: {{ include "caracal.chart" . }}
{{ include "caracal.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "caracal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "caracal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name for the init Job.
*/}}
{{- define "caracal.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (printf "%s-init" (include "caracal.fullname" .)) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the Secret holding all sensitive env vars.
*/}}
{{- define "caracal.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- printf "%s-secret" (include "caracal.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Name of the ConfigMap holding non-sensitive env vars.
*/}}
{{- define "caracal.configMapName" -}}
{{- printf "%s-config" (include "caracal.fullname" .) }}
{{- end }}

{{/*
Image pull policy helper. Takes a dict with repository, tag, pullPolicy,
and optional appVersion fallback.
*/}}
{{- define "caracal.image" -}}
{{- $registry := .global.imageRegistry -}}
{{- $repo := .image.repository -}}
{{- $tag := .image.tag | default (.appVersion | default "latest") -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repo $tag -}}
{{- else -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end }}

{{/*
Standard initContainer: wait for Postgres readiness.
*/}}
{{- define "caracal.initWaitPostgres" -}}
{{- if .Values.postgresql.enabled }}
- name: wait-for-postgres
  image: postgres:16
  imagePullPolicy: IfNotPresent
  command:
    - sh
    - -c
    - |
      until pg_isready -h {{ include "caracal.fullname" . }}-db -U postgres; do
        echo "Waiting for Postgres..."; sleep 2;
      done
  env:
    - name: PGPASSWORD
      valueFrom:
        secretKeyRef:
          name: {{ include "caracal.secretName" . }}
          key: POSTGRES_PASSWORD
{{- end }}
{{- end }}

{{/*
Standard initContainer: wait for ClickHouse readiness.
*/}}
{{- define "caracal.initWaitClickhouse" -}}
{{- if .Values.clickhouse.enabled }}
- name: wait-for-clickhouse
  image: curlimages/curl:8.8.0
  imagePullPolicy: IfNotPresent
  command:
    - sh
    - -c
    - |
      until curl -sf http://{{ include "caracal.fullname" . }}-clickhouse:8123/ping; do
        echo "Waiting for ClickHouse..."; sleep 2;
      done
{{- end }}
{{- end }}

{{/*
Standard initContainer: wait for Redis readiness.
*/}}
{{- define "caracal.initWaitRedis" -}}
{{- if .Values.redis.enabled }}
- name: wait-for-redis
  image: redis:7-alpine
  imagePullPolicy: IfNotPresent
  command:
    - sh
    - -c
    - |
      until redis-cli -h {{ include "caracal.fullname" . }}-redis ping | grep -q PONG; do
        echo "Waiting for Redis..."; sleep 2;
      done
{{- end }}
{{- end }}

{{/*
Standard initContainer: wait for init Job completion.
Polls the Job's succeeded count via the K8s API using the init ServiceAccount.
*/}}
{{- define "caracal.initWaitInitJob" -}}
- name: wait-for-init
  image: bitnami/kubectl:latest
  imagePullPolicy: IfNotPresent
  command:
    - sh
    - -c
    - |
      JOB="{{ include "caracal.fullname" . }}-init"
      NS="{{ .Release.Namespace }}"
      echo "Waiting for init Job $JOB to complete..."
      until [ "$(kubectl get job $JOB -n $NS -o jsonpath='{.status.succeeded}' 2>/dev/null)" = "1" ]; do
        echo "  init Job not yet succeeded, retrying in 5s..."; sleep 5;
      done
      echo "Init Job completed."
{{- end }}

{{/*
Standard container security context for the distroless server image.
*/}}
{{- define "caracal.securityContext" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  runAsNonRoot: true
  runAsUser: 65532
  runAsGroup: 65532
  seccompProfile:
    type: RuntimeDefault
{{- end }}

{{/*
Standard pod security context.
*/}}
{{- define "caracal.podSecurityContext" -}}
securityContext:
  seccompProfile:
    type: RuntimeDefault
{{- end }}
