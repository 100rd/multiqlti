{{/*
Expand the name of the chart.
*/}}
{{- define "multiqlti.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "multiqlti.fullname" -}}
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
{{- define "multiqlti.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "multiqlti.labels" -}}
helm.sh/chart: {{ include "multiqlti.chart" . }}
{{ include "multiqlti.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "multiqlti.selectorLabels" -}}
app.kubernetes.io/name: {{ include "multiqlti.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use.
*/}}
{{- define "multiqlti.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "multiqlti.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Database URL — resolves from subchart or external config.
*/}}
{{- define "multiqlti.databaseUrl" -}}
{{- if .Values.postgresql.enabled }}
{{- $host := printf "%s-postgresql" .Release.Name }}
{{- $user := .Values.postgresql.auth.username }}
{{- $db := .Values.postgresql.auth.database }}
{{- printf "postgresql://%s:$(POSTGRES_PASSWORD)@%s:5432/%s" $user $host $db }}
{{- else }}
{{- .Values.externalDatabase.url }}
{{- end }}
{{- end }}

{{/*
Secret name for app secrets.
*/}}
{{- define "multiqlti.secretName" -}}
{{- if .Values.secrets.create }}
{{- include "multiqlti.fullname" . }}
{{- else }}
{{- required "secrets.create must be true or envFromSecrets must be configured" "" }}
{{- end }}
{{- end }}
