# Docker Deployment Guide

This guide covers a cold start through a running production deployment of multiqlti using Docker Compose.

---

## Hardware Requirements

| Profile | CPU | RAM | Storage | GPU |
|---------|-----|-----|---------|-----|
| `cloud-only` | 2 cores | 4 GB | 20 GB | None |
| `dev` | 4 cores | 8 GB | 40 GB | None (Ollama CPU) |
| `full` | 8 cores | 32 GB | 200 GB | NVIDIA, 24 GB+ VRAM |

---

## Prerequisites

- Docker Engine 24+ and Docker Compose v2
- `curl` and `openssl` on the host
- A domain name pointed at your server (for HTTPS / Let's Encrypt)
- For `full` profile: NVIDIA drivers + `nvidia-container-toolkit`

---

## Cold Start: First Deployment

### 1. Clone the repository

```bash
git clone https://github.com/100rd/multiqlti.git
cd multiqlti
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set the following **required** values:

| Variable | How to set |
|----------|-----------|
| `POSTGRES_PASSWORD` | `openssl rand -hex 16` |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `CADDY_DOMAIN` | Your domain (e.g. `multiqlti.example.com`) or `localhost` for dev |

Also set your AI provider API key(s) if using cloud providers:
```
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Choose a profile and start

**Development (no GPU, Ollama for local AI):**
```bash
docker compose --profile dev up -d
```

**Cloud-only (no local AI, API keys required):**
```bash
docker compose --profile cloud-only up -d
```

**Full stack (NVIDIA GPU required):**
```bash
docker compose --profile full up -d
```

### 4. Verify the deployment

```bash
# Check all services are running
docker compose ps

# Check application health
curl http://localhost/api/health

# View logs
docker compose logs -f multiqlti
```

Caddy provisions a TLS certificate on first start. If `CADDY_DOMAIN` is a real domain, the app is available at `https://yourdomain.com` within ~30 seconds.

---

## Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSTGRES_USER` | No | `multiqlti` | PostgreSQL username |
| `POSTGRES_PASSWORD` | **Yes** | — | PostgreSQL password |
| `POSTGRES_DB` | No | `multiqlti` | PostgreSQL database name |
| `DATABASE_URL` | No | auto-constructed | Override for external/managed DB |
| `JWT_SECRET` | **Yes** | — | JWT signing secret, min 32 chars |
| `CADDY_DOMAIN` | No | `localhost` | Domain for TLS cert provisioning |
| `APP_PORT` | No | `5050` | Host port (dev mode only) |
| `SANDBOX_ENABLED` | No | `true` | Enable code sandbox |
| `SANDBOX_MAX_CONCURRENT` | No | `3` | Max concurrent sandbox executions |
| `SANDBOX_DEFAULT_TIMEOUT` | No | `120` | Sandbox timeout in seconds |
| `VLLM_MODEL` | No | `meta-llama/Meta-Llama-3-70B-Instruct` | Model loaded by vLLM |
| `GRAFANA_PASSWORD` | No | `admin` | Grafana admin password |

---

## Database Migrations

Migrations run **automatically** on every container startup via:
```
npm run db:push && node dist/index.cjs
```

To run migrations manually (e.g. during a zero-downtime upgrade):
```bash
docker compose exec multiqlti npm run db:push
```

---

## Upgrade Procedure

```bash
# 1. Pull latest code
git pull

# 2. Rebuild the app image
docker compose --profile <your-profile> build multiqlti

# 3. Restart with new image (migrations run automatically)
docker compose --profile <your-profile> up -d --no-deps multiqlti
```

For major version upgrades, always check `CHANGELOG.md` for breaking changes before upgrading.

---

## Backup and Restore

### Automated Backups

The `postgres-backup` service runs a daily `pg_dump` at 02:00 UTC to the `pgbackups` volume, keeping the last 7 dumps.

List backups:
```bash
docker compose exec postgres-backup ls /backups/
```

### Manual Backup

```bash
docker compose exec postgres pg_dump -U multiqlti multiqlti > backup_$(date +%Y%m%d).sql
```

### Restore from Backup

```bash
# Copy backup file into the container
docker compose cp backup_20240101.sql postgres:/tmp/

# Restore
docker compose exec postgres psql -U multiqlti multiqlti < /tmp/backup_20240101.sql
```

---

## Monitoring (Optional)

Enable the monitoring stack on top of any running profile:

```bash
docker compose --profile monitoring up -d
```

This starts:
- **Prometheus** — scrapes application and infrastructure metrics
- **Loki** — aggregates container logs
- **Grafana** — dashboards (default login: admin / `$GRAFANA_PASSWORD`)

Access Grafana via the Caddy reverse proxy at `/grafana` (configure Caddy route) or directly on port 3000 via `docker compose exec`.

---

## Profiles Reference

| Profile | Services | Use case |
|---------|----------|----------|
| `dev` | app + postgres + ollama + caddy | Local dev, no GPU |
| `cloud-only` | app + postgres + caddy | Cloud AI only |
| `full` | app + postgres + vllm + ollama + caddy | On-premise GPU |
| `monitoring` | + prometheus + loki + grafana | Observability layer |

Profiles can be combined:
```bash
docker compose --profile full --profile monitoring up -d
```

---

## Network Architecture

All services communicate on the `internal` bridge network. Only Caddy exposes external ports:

```
Internet
    │
    ▼
  Caddy :80/:443
    │
    ▼  (internal bridge)
  multiqlti :5000
    │
    ├── postgres :5432
    ├── vllm :8000
    └── ollama :11434
```

PostgreSQL is **never** directly accessible from outside Docker. To connect with a local client temporarily, use `docker-compose.override.yml`:
```yaml
services:
  postgres:
    ports:
      - "5432:5432"
```

---

## Troubleshooting

### App fails to start — "JWT_SECRET must be set"

`JWT_SECRET` is required and not set in `.env`. Generate one:
```bash
openssl rand -hex 32
```

### App fails to start — "POSTGRES_PASSWORD must be set"

`POSTGRES_PASSWORD` is required. Set it in `.env`.

### Caddy shows "certificate provisioning error"

- Ensure port 80 and 443 are open in your firewall
- Ensure `CADDY_DOMAIN` resolves to this server's public IP
- Check Caddy logs: `docker compose logs caddy`

### Database connection refused

- Ensure the `postgres` service is healthy: `docker compose ps`
- Check if `DATABASE_URL` in `.env` matches your credentials

### vLLM fails to start (GPU not found)

- Confirm NVIDIA drivers are installed: `nvidia-smi`
- Install nvidia-container-toolkit: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html
- Test GPU in Docker: `docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi`

### Health endpoint returns "unhealthy"

The app is running but cannot reach the database. Check:
1. `docker compose ps` — is `postgres` healthy?
2. `docker compose logs postgres` — any startup errors?
3. Is `POSTGRES_PASSWORD` the same in postgres and multiqlti services?

---

## Security Checklist

Before going to production:

- [ ] `POSTGRES_PASSWORD` changed from default
- [ ] `JWT_SECRET` is at least 32 random characters
- [ ] `.env` is not committed to git
- [ ] `CADDY_DOMAIN` set to your real domain (enables HTTPS)
- [ ] Firewall: only ports 80 and 443 are open externally
- [ ] PostgreSQL port 5432 is NOT exposed to the host
- [ ] Regular backups verified by restoring to a test environment
