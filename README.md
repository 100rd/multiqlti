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
# Edit .env — at minimum set your AI provider API keys
```

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

The application is available at `http://localhost:5050` once the `multiqlti` service is healthy.

Database migrations run automatically on every startup before the server starts. To run them manually:
```bash
docker compose exec multiqlti npm run db:push
```

---

## Profiles

| Profile | Services | Use case |
|---------|----------|----------|
| `dev` | app + postgres + ollama | Local development, no GPU |
| `cloud-only` | app + postgres | Cloud AI providers only |
| `full` | app + postgres + vllm + ollama | On-premise GPU inference |

---

## Environment Variables

Copy `.env.example` to `.env`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_USER` | `multiqlti` | DB username |
| `POSTGRES_PASSWORD` | `multiqlti_dev` | DB password — **change in production** |
| `POSTGRES_DB` | `multiqlti` | DB name |
| `DATABASE_URL` | auto-constructed | Override to use external DB |
| `APP_PORT` | `5050` | Host port for the web UI |
| `SANDBOX_ENABLED` | `true` | Enable/disable code sandbox |
| `VLLM_MODEL` | `meta-llama/Meta-Llama-3-70B-Instruct` | Model to load in vLLM |

---

## Custom Configuration

To override defaults without editing `docker-compose.yml`:

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
# Edit docker-compose.override.yml with your customisations
```

The override file is automatically merged by Docker Compose. Never commit it to git.

---

## Data Persistence

All persistent data is stored in named Docker volumes:

| Volume | Contents |
|--------|----------|
| `pgdata` | PostgreSQL database files |
| `ollama_data` | Downloaded Ollama models |
| `vllm_cache` | Hugging Face model cache |

To back up the database:
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

## Upgrading

```bash
git pull
docker compose --profile dev pull
docker compose --profile dev up -d --build
```

Migrations run automatically on startup.

---

## Troubleshooting

**App fails to connect to database**
- Ensure the `postgres` service is healthy: `docker compose ps`
- Check logs: `docker compose logs postgres`
- Verify `DATABASE_URL` in your `.env` matches Postgres credentials

**vLLM fails to start**
- Confirm NVIDIA drivers and `nvidia-container-toolkit` are installed
- Check GPU visibility: `docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi`
- Use `--profile dev` or `--profile cloud-only` if no GPU is available

**Port 5050 already in use**
- Set `APP_PORT=8080` (or another free port) in your `.env`
