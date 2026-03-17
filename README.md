# multiqlti

A multi-provider AI pipeline orchestration platform supporting parallel model execution, agent swarms, and enterprise governance.

---

## Quick Start

### Prerequisites

| Profile | Requirements |
|---------|-------------|
| `dev` | Docker, Docker Compose, 8 GB RAM |
| `cloud-only` | Docker, Docker Compose, API keys for Anthropic/OpenAI |
| `full` | Docker, Docker Compose, NVIDIA GPU with CUDA, 24 GB+ VRAM |

### 1. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set **at minimum**:
- `POSTGRES_PASSWORD` — generate with `openssl rand -hex 16`
- `JWT_SECRET` — generate with `openssl rand -hex 32`
- `CADDY_DOMAIN` — your domain (or `localhost` for local dev)

### 2. Start the stack

**Development mode** (Ollama for local AI, no GPU required):
```bash
docker compose --profile dev up -d
```

**Cloud-only mode** (Anthropic / OpenAI, no local AI):
```bash
docker compose --profile cloud-only up -d
```

**Full stack** (vLLM + Ollama, requires NVIDIA GPU):
```bash
docker compose --profile full up -d
```

The application is served through Caddy:
- Local dev: `http://localhost`
- Production: `https://yourdomain.com` (TLS auto-provisioned via Let's Encrypt)

Database migrations run automatically on every startup. To run them manually:
```bash
docker compose exec multiqlti npm run db:push
```

---

## Health Check

```bash
curl http://localhost/api/health
```

Returns DB status, provider status, and overall health. Used by Docker and load balancers.

---

## Profiles

| Profile | Services | Use case |
|---------|----------|----------|
| `dev` | app + postgres + ollama + caddy | Local development, no GPU |
| `cloud-only` | app + postgres + caddy | Cloud AI providers only |
| `full` | app + postgres + vllm + ollama + caddy | On-premise GPU inference |
| `monitoring` | + prometheus + loki + grafana | Observability (add to any profile) |

```bash
# Full stack with monitoring
docker compose --profile full --profile monitoring up -d
```

---

## Environment Variables

Copy `.env.example` to `.env`. Required variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `POSTGRES_PASSWORD` | Yes | DB password — generate with `openssl rand -hex 16` |
| `JWT_SECRET` | Yes | JWT signing key — generate with `openssl rand -hex 32` |
| `CADDY_DOMAIN` | No | Domain for HTTPS (default: `localhost`) |
| `POSTGRES_USER` | No | DB username (default: `multiqlti`) |
| `POSTGRES_DB` | No | DB name (default: `multiqlti`) |
| `DATABASE_URL` | No | Override to use external/managed DB |
| `SANDBOX_ENABLED` | No | Enable code sandbox (default: `true`) |
| `VLLM_MODEL` | No | vLLM model (default: Llama-3-70B) |

---

## Custom Configuration

To override defaults without editing `docker-compose.yml`:

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
# Edit docker-compose.override.yml
```

Never commit `docker-compose.override.yml` to git — it is listed in `.gitignore`.

---

## Data Persistence

All persistent data lives in named Docker volumes:

| Volume | Contents |
|--------|----------|
| `pgdata` | PostgreSQL database files |
| `pgbackups` | Automated daily `pg_dump` backups (last 7) |
| `ollama_data` | Downloaded Ollama models |
| `vllm_cache` | Hugging Face model cache |
| `caddy_data` | TLS certificates |

Manual backup:
```bash
docker compose exec postgres pg_dump -U multiqlti multiqlti > backup.sql
```

---

## Stopping and Cleanup

```bash
# Stop services (data preserved)
docker compose --profile dev down

# Stop and remove volumes (destroys all data)
docker compose --profile dev down -v
```

---

## Production Deployment

See [docs/DEPLOYMENT_DOCKER.md](docs/DEPLOYMENT_DOCKER.md) for:
- Cold start guide
- Upgrade procedure
- Backup and restore
- Monitoring setup
- Security checklist
- Troubleshooting

---

## Troubleshooting

**App fails to start — "JWT_SECRET must be set"**
- Set `JWT_SECRET` in your `.env`: `openssl rand -hex 32`

**App fails to connect to database**
- Check service health: `docker compose ps`
- Check logs: `docker compose logs postgres`
- Verify `POSTGRES_PASSWORD` is identical in both postgres and multiqlti services

**vLLM fails to start**
- Confirm NVIDIA drivers: `nvidia-smi`
- Install `nvidia-container-toolkit`
- Use `--profile dev` or `--profile cloud-only` if no GPU is available

**Caddy fails to get TLS certificate**
- Ensure ports 80 and 443 are open in your firewall
- Ensure `CADDY_DOMAIN` resolves to this server's IP
- Check: `docker compose logs caddy`
