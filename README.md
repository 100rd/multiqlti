# multiqlti

A self-hosted platform that runs software development tasks through a pipeline of specialized AI agents. You describe what you want — the pipeline plans, architects, codes, tests, reviews, and deploys it.

Works with cloud AI (Claude, Gemini, Grok) or fully local (Ollama, vLLM). Your data, your infrastructure.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         User / API / Webhook                        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                        ┌──────▼──────┐
                        │    Caddy    │  TLS termination, reverse proxy
                        └──────┬──────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                      multiqlti (Node.js)                            │
│                                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │  Auth/RBAC  │  │  Pipeline    │  │  Execution Strategies     │  │
│  │  JWT + roles│  │  Controller  │  │  ┌───────┐ ┌──────────┐  │  │
│  └─────────────┘  │  ┌────────┐ │  │  │Single │ │Debate    │  │  │
│                    │  │ Linear │ │  │  │ pass  │ │3 models  │  │  │
│  ┌─────────────┐  │  │ DAG    │ │  │  │       │ │argue +   │  │  │
│  │  Skills     │  │  │ Swarm  │ │  │  └───────┘ │judge     │  │  │
│  │  Marketplace│  │  │ Manager│ │  │  ┌───────┐ └──────────┘  │  │
│  └─────────────┘  │  └────────┘ │  │  │MoA    │ ┌──────────┐  │  │
│                    └──────┬─────┘  │  │N prop +│ │Voting    │  │  │
│  ┌─────────────┐         │        │  │1 merge │ │K models  │  │  │
│  │  Workspace  │   ┌─────▼─────┐  │  └───────┘ │consensus │  │  │
│  │  Git, Index │   │  Gateway  │  │            └──────────┘  │  │
│  │  Code Chat  │   │  Router   │  └───────────────────────────┘  │
│  └─────────────┘   └─────┬─────┘                                 │
│                          │                                        │
│  ┌─────────────┐   ┌─────▼─────────────────────────────────────┐ │
│  │  Guardrails │   │              AI Providers                  │ │
│  │  Privacy    │   │  ┌────────┐ ┌──────┐ ┌────┐ ┌───────────┐│ │
│  │  Sandbox    │   │  │Claude  │ │Gemini│ │Grok│ │LM Studio  ││ │
│  └─────────────┘   │  │(cloud) │ │(cloud│ │(cl)│ │(local)    ││ │
│                     │  └────────┘ └──────┘ └────┘ └───────────┘│ │
│  ┌─────────────┐   │  ┌────────┐ ┌──────────────┐             │ │
│  │  Memory     │   │  │Ollama  │ │vLLM (GPU)    │             │ │
│  │  Triggers   │   │  │(local) │ │(self-hosted)  │             │ │
│  │  Federation │   │  └────────┘ └──────────────┘             │ │
│  └─────────────┘   └───────────────────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                ┌──────────────▼──────────────┐
                │  PostgreSQL    Redis         │
                │  (data store)  (queue/cache) │
                └─────────────────────────────┘
```

### The Pipeline

Each stage uses a specialized AI agent with its own model and role:

```
You: "Build a REST API for user management"
 │
 ├─ Planning Agent ──────→ tasks, acceptance criteria, risks
 ├─ Architecture Agent ──→ components, tech stack, API contracts
 ├─ Development Agent ───→ source code files
 ├─ Testing Agent ───────→ test suites, coverage targets
 ├─ Code Review Agent ───→ security audit, quality score, approve/reject
 ├─ Deployment Agent ────→ Dockerfile, CI/CD, K8s manifests
 ├─ Monitoring Agent ────→ dashboards, alerts, health checks
 └─ Fact Check Agent ────→ verify libraries exist, flag hallucinations
```

Stages can run in sequence, as a DAG (parallel + conditional), or as a swarm (clone task across N agents, merge results).

---

## Quick Start

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD, JWT_SECRET, CADDY_DOMAIN in .env

docker compose --profile dev up -d    # Local (Ollama, no GPU)
```

Open `https://localhost`. Migrations run automatically.

<details>
<summary><b>Other profiles</b></summary>

```bash
docker compose --profile cloud-only up -d   # Cloud AI only (Anthropic/Google/XAI)
docker compose --profile full up -d         # GPU inference (vLLM + Ollama)
docker compose --profile full --profile monitoring up -d  # + Prometheus/Grafana
```

| Profile | Services | Use case |
|---------|----------|----------|
| `dev` | app + postgres + ollama + caddy | Local, no GPU |
| `cloud-only` | app + postgres + caddy | Cloud providers only |
| `full` | app + postgres + vllm + ollama + caddy | On-premise GPU |
| `monitoring` | + prometheus + loki + grafana | Add to any profile |

</details>

---

## Usage Patterns

<details>
<summary><b>AI Code Factory</b> — describe a feature, get full implementation</summary>

Create a pipeline with stages: Planning → Architecture → Development → Testing → Code Review. Assign different models per stage (e.g. Claude for planning, DeepSeek for coding). Run it with a feature description as input.

**Output**: planned tasks, API design, implementation files, test suite, review report — all structured JSON.

</details>

<details>
<summary><b>Multi-Model Code Review</b> — 3 models debate your code</summary>

Connect a GitHub workspace, select files, run a Code Review + Security Analysis pipeline in Debate mode. Three models independently analyze the code, then argue over findings with a judge model making the final call.

</details>

<details>
<summary><b>Architecture Decision Engine</b> — models argue for different approaches</summary>

Use the Debate execution strategy on the Architecture stage. Configure roles:
- Proposer argues for microservices
- Critic argues for monolith
- Devil's advocate argues for serverless
- Judge evaluates on scalability, cost, maintainability

Get a structured, reasoned architecture decision with tradeoffs documented.

</details>

<details>
<summary><b>Automated PR Quality Gate</b> — webhook-triggered review on every PR</summary>

Set up a Trigger (webhook type) that fires on GitHub PR events. The trigger runs a pipeline: Code Review → Security Analysis → Fact Check. Results post back as a PR comment. Every PR gets multi-model review automatically.

</details>

<details>
<summary><b>Research & Analysis</b> — fan-out to multiple models, aggregate</summary>

Create a Task Group with parallel tasks:
- Task 1: Research option A (model: Claude)
- Task 2: Research option B (model: Gemini)
- Task 3: Research option C (model: Grok)
- Task 4: Compare all → recommendation (depends on 1,2,3)

Multiple models research in parallel. A final task synthesizes findings.

</details>

<details>
<summary><b>Multi-Model Consensus</b> — 5 models vote, only agreement passes</summary>

Use the Voting execution strategy with 5 candidate models and a 60% threshold. Use this for high-stakes decisions where hallucination is costly (e.g. "Is this contract vulnerable to reentrancy?").

</details>

<details>
<summary><b>Air-Gapped / Local-Only</b> — no data leaves your network</summary>

Deploy with `--profile dev` (Ollama only). Enable Privacy anonymization patterns to strip PII before model calls. Code execution runs in sandboxed Docker containers. No external API calls.

</details>

<details>
<summary><b>Workspace Code Chat</b> — talk to your codebase</summary>

Connect a workspace (local path or GitHub URL). The platform indexes your code (AST parsing), builds a dependency graph, and lets you chat with an AI model that has full context of your codebase. Ask questions, request reviews, generate docs.

</details>

---

## Environment Variables

Copy `.env.example` to `.env`. Required:

| Variable | Required | Description |
|----------|----------|-------------|
| `POSTGRES_PASSWORD` | Yes | `openssl rand -hex 16` |
| `JWT_SECRET` | Yes | `openssl rand -hex 32` |
| `CADDY_DOMAIN` | No | Domain for HTTPS (default: `localhost`) |

<details>
<summary><b>All variables</b></summary>

| Variable | Required | Description |
|----------|----------|-------------|
| `POSTGRES_USER` | No | DB username (default: `multiqlti`) |
| `POSTGRES_DB` | No | DB name (default: `multiqlti`) |
| `DATABASE_URL` | No | Override for external DB |
| `SANDBOX_ENABLED` | No | Code sandbox (default: `true`) |
| `VLLM_MODEL` | No | vLLM model (default: Llama-3-70B) |
| `ANTHROPIC_API_KEY` | No | Claude provider |
| `GOOGLE_API_KEY` | No | Gemini provider |
| `XAI_API_KEY` | No | Grok provider |

</details>

---

## Health Check

```bash
curl https://localhost/api/health
```

---

## Data Persistence

| Volume | Contents |
|--------|----------|
| `pgdata` | PostgreSQL database |
| `pgbackups` | Daily `pg_dump` backups (last 7) |
| `workspace_data` | Cloned workspace repositories |
| `ollama_data` | Downloaded Ollama models |
| `vllm_cache` | Hugging Face model cache |
| `caddy_data` | TLS certificates |

<details>
<summary><b>Backup & restore</b></summary>

```bash
# Manual backup
docker compose exec postgres pg_dump -U multiqlti multiqlti > backup.sql

# Restore
cat backup.sql | docker compose exec -T postgres psql -U multiqlti multiqlti
```

</details>

---

## Custom Configuration

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
# Edit as needed — never committed to git
```

---

## Stopping

```bash
docker compose --profile dev down      # Stop (data preserved)
docker compose --profile dev down -v   # Stop + delete all data
```

---

## Production

See [docs/DEPLOYMENT_DOCKER.md](docs/DEPLOYMENT_DOCKER.md) for cold start, upgrades, monitoring, security checklist.

Kubernetes: Helm charts in `helm/multiqlti/` with dev/staging/prod value overrides.

---

## Troubleshooting

<details>
<summary><b>Common issues</b></summary>

**"JWT_SECRET must be set"** — Set it in `.env`: `openssl rand -hex 32`

**DB connection fails** — Check `docker compose ps`, verify `POSTGRES_PASSWORD` matches in both services.

**vLLM fails** — Run `nvidia-smi` to confirm GPU. Install `nvidia-container-toolkit`. Or use `--profile dev`.

**Caddy TLS fails** — Open ports 80+443, verify `CADDY_DOMAIN` DNS resolves to this server.

**Ollama unhealthy** — The healthcheck uses `ollama list`. Check `docker compose logs ollama`.

</details>
