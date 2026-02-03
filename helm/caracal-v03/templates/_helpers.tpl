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
Create chart name and version as used by the chart label.
*/}}
{{- define "caracal.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
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
Selector labels
*/}}
{{- define "caracal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "caracal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "caracal.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "caracal.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
PostgreSQL host
*/}}
{{- define "caracal.postgresql.host" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "%s-postgres" (include "caracal.fullname" .) }}
{{- else }}
{{- .Values.postgresql.externalHost }}
{{- end }}
{{- end }}

{{/*
Redis host
*/}}
{{- define "caracal.redis.host" -}}
{{- if .Values.redis.enabled }}
{{- printf "%s-redis" (include "caracal.fullname" .) }}
{{- else }}
{{- .Values.redis.externalHost }}
{{- end }}
{{- end }}

{{/*
Kafka bootstrap servers
*/}}
{{- define "caracal.kafka.bootstrapServers" -}}
{{- if .Values.kafka.enabled }}
{{- $fullname := include "caracal.fullname" . }}
{{- $replicas := int .Values.kafka.replicaCount }}
{{- $servers := list }}
{{- range $i := until $replicas }}
{{- $servers = append $servers (printf "%s-kafka-%d.%s-kafka:9092" $fullname $i $fullname) }}
{{- end }}
{{- join "," $servers }}
{{- else }}
{{- .Values.kafka.externalBootstrapServers }}
{{- end }}
{{- end }}

{{/*
Schema Registry URL
*/}}
{{- define "caracal.schemaRegistry.url" -}}
{{- if .Values.schemaRegistry.enabled }}
{{- printf "http://%s-schema-registry:%d" (include "caracal.fullname" .) (int .Values.schemaRegistry.service.port) }}
{{- else }}
{{- .Values.schemaRegistry.externalUrl }}
{{- end }}
{{- end }}
