# Kubernetes Deployment Guide

Deploy multiqlti to Kubernetes using the Helm chart with environment-specific configurations.

## Prerequisites

- Kubernetes cluster (1.26+)
- Helm 3.12+
- kubectl configured for target cluster
- Container registry with multiqlti image

## Quick Start

```bash
# Build and push the Docker image
docker build -t your-registry/multiqlti:latest .
docker push your-registry/multiqlti:latest

# Add Bitnami repo for PostgreSQL dependency
helm repo add bitnami https://charts.bitnami.com/bitnami
helm dependency build helm/multiqlti

# Install (dev)
helm install multiqlti helm/multiqlti \
  -f helm/multiqlti/values-dev.yaml \
  --set image.repository=your-registry/multiqlti \
  --set secrets.jwtSecret="$(openssl rand -hex 32)" \
  --set postgresql.auth.password="$(openssl rand -hex 16)" \
  -n multiqlti --create-namespace
```

## Environment Configurations

| File | Replicas | DB | HPA | NetworkPolicy | TLS |
|------|----------|----|-----|---------------|-----|
| `values-dev.yaml` | 1 | In-cluster | No | No | No |
| `values-staging.yaml` | 2 | In-cluster | 2-4 | Yes | Let's Encrypt staging |
| `values-prod.yaml` | 3 | External (RDS) | 3-10 | Yes | Let's Encrypt prod |

## Production Setup

### 1. Create Secrets

```bash
# Database credentials (external DB)
kubectl create secret generic multiqlti-db-credentials \
  --from-literal=database-url="postgresql://user:pass@rds-host:5432/multiqlti" \
  -n multiqlti

# Application secrets
kubectl create secret generic multiqlti-app-secrets \
  --from-literal=jwt-secret="$(openssl rand -hex 32)" \
  --from-literal=anthropic-api-key="sk-ant-..." \
  -n multiqlti
```

### 2. Install

```bash
helm install multiqlti helm/multiqlti \
  -f helm/multiqlti/values-prod.yaml \
  --set image.repository=your-registry/multiqlti \
  --set image.tag=v1.0.0 \
  --set ingress.hosts[0].host=multiqlti.yourdomain.com \
  --set ingress.tls[0].hosts[0]=multiqlti.yourdomain.com \
  -n multiqlti --create-namespace
```

### 3. Verify

```bash
# Check pods
kubectl get pods -n multiqlti

# Check health
kubectl exec deploy/multiqlti -n multiqlti -- wget -qO- http://localhost:5000/api/health

# Check ingress
kubectl get ingress -n multiqlti
```

## ArgoCD GitOps

Enable ArgoCD to manage the deployment:

```bash
helm install multiqlti helm/multiqlti \
  -f helm/multiqlti/values-prod.yaml \
  --set argocd.enabled=true \
  --set argocd.repoURL=https://github.com/your-org/multiqlti \
  --set argocd.targetRevision=main \
  -n multiqlti
```

This creates an ArgoCD `Application` resource that auto-syncs from git. Combined with Phase 6.10 (ArgoCD MCP), multiqlti can monitor its own deployment status.

## Scaling

HPA scales based on CPU and memory. Configure in values:

```yaml
autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 60
```

The `PodDisruptionBudget` ensures zero-downtime during rolling updates.

## Architecture

```
                    ┌─────────────┐
                    │   Ingress   │
                    │ (nginx+TLS) │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  Service    │
                    │ (ClusterIP) │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼─────┐┌────▼─────┐┌────▼─────┐
        │  Pod (app) ││ Pod (app) ││ Pod (app) │
        │  port 5000 ││ port 5000 ││ port 5000 │
        └─────┬──────┘└────┬─────┘└────┬─────┘
              │            │            │
              └────────────┼────────────┘
                           │
                    ┌──────▼──────┐
                    │ PostgreSQL  │
                    │ (in-cluster │
                    │  or RDS)    │
                    └─────────────┘
```

## Helm Values Reference

| Key | Default | Description |
|-----|---------|-------------|
| `replicaCount` | 1 | Number of app replicas |
| `image.repository` | multiqlti | Container image |
| `image.tag` | Chart appVersion | Image tag |
| `ingress.enabled` | false | Enable ingress |
| `postgresql.enabled` | true | Deploy in-cluster PostgreSQL |
| `externalDatabase.url` | "" | External DB connection string |
| `autoscaling.enabled` | false | Enable HPA |
| `networkPolicy.enabled` | false | Enable network restrictions |
| `argocd.enabled` | false | Create ArgoCD Application |
| `sandbox.enabled` | false | Enable code execution sandbox |

## Upgrading

```bash
# Rolling update (zero downtime with PDB)
helm upgrade multiqlti helm/multiqlti \
  -f helm/multiqlti/values-prod.yaml \
  --set image.tag=v1.1.0 \
  -n multiqlti
```

Database migrations run automatically on pod startup via Drizzle ORM.
