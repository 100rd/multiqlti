# Host deployment — server on host, infra in Docker

This is the deployment mode to use **on a developer machine (macOS) where the
`claude` and `agy` CLIs are installed**. The multiqlti server runs directly on
the host; only Postgres and Redis run in Docker.

For the fully containerised production setup see
[DEPLOYMENT_DOCKER.md](DEPLOYMENT_DOCKER.md); for Kubernetes see
[DEPLOYMENT_K8S.md](DEPLOYMENT_K8S.md).

---

## Why the server cannot run in Docker here

multiqlti's default LLM providers do **not** call a cloud HTTP API — they shell
out to **locally installed CLI binaries**:

| Provider key            | Default                        | Spawns binary | Auth source                     |
| ----------------------- | ------------------------------ | ------------- | ------------------------------- |
| `anthropic`             | `mode: "cli"`                  | `claude`      | `~/.claude` (host login)        |
| `antigravity` / `google`| `enabled: true`                | `agy`         | `~/.gemini/antigravity-cli`     |

- `server/gateway/providers/claude-cli.ts` → `spawn("claude", …)`
- `server/gateway/providers/antigravity-cli.ts` → `execFile("agy", …)`

The production image (`Dockerfile`) is `node:20-alpine` with only `git` added —
neither binary exists inside it. A container also has its own filesystem and
PATH, so it can never see the host's `~/.local/bin/claude` / `~/.local/bin/agy`.
Worse, **`agy` is a macOS-native binary** and would not execute inside a Linux
container even if mounted. Hence the server must run on the host, where both
binaries and their auth live.

Symptom when run in Docker:

```
Error: CLI binary "claude" is not installed or not on PATH
Error: Antigravity CLI binary not found on PATH. Install Antigravity and run `agy install`.
```

---

## Prerequisites

- Node.js (the repo's `node_modules` already installed via `npm install`)
- Docker (daemon running)
- `claude` on PATH and logged in — verify: `claude --version`
- `agy` on PATH and logged in — verify: `agy --version`
- A populated `.env` (copy from `.env.example`; needs at least
  `POSTGRES_PASSWORD` and `JWT_SECRET`)

Run the built-in check:

```bash
make doctor
```

Example healthy output:

```
claude     : 2.1.167 (Claude Code)
agy        : 1.0.5
node       : v26.0.0
docker     : daemon up
pg :5432   : open
redis :6379: open
```

---

## Quick start

```bash
cd project/multiqlti

make infra-up    # start ONLY Postgres + Redis in Docker
make dev         # run the server on the host (hot reload)
```

The server listens on `http://localhost:${APP_PORT}` (default **5050**, from
`.env`). Open it directly — there is no Caddy in front in this mode.

To stop:

```bash
make infra-down  # stop the containers (data preserved)
```

---

## How it is wired

Two host-local files (both gitignored) make this work:

### `docker-compose.override.yml`

Auto-loaded by `docker compose` next to `docker-compose.yml`. It publishes the
Postgres port to the host so the host-run server can connect (Redis already
publishes `6379`):

```yaml
services:
  postgres:
    ports:
      - "5432:5432"
```

The base `multiqlti` and `caddy` services have `profiles:` set, so they only
start when their profile is active. `make infra-up` runs
`docker compose up -d postgres redis` — naming the services explicitly starts
**only** those two, leaving the app/caddy services down.

### `scripts/dev-host.sh`

Launches the server on the host. It:

1. Sources `.env` (the Node app has no `dotenv` dependency, so env must be
   exported explicitly).
2. Overrides the in-container hostnames with host-published ports:
   - `DATABASE_URL` → `postgres://…@localhost:5432/…`
   - `REDIS_URL`    → `redis://localhost:6379`
   - `PORT`         → `${APP_PORT:-5050}`
3. Warns if `claude` / `agy` are missing from PATH.
4. Runs the server. Mode is selected by an optional argument:
   - `./scripts/dev-host.sh dev` — hot-reload dev server (`npm run dev`)
   - `./scripts/dev-host.sh start` — build, then run the prod bundle (`npm start`)

---

## Makefile reference

| Target           | Description                                                            |
| ---------------- | ---------------------------------------------------------------------- |
| `make help`      | List all targets (default goal)                                        |
| `make doctor`    | Check host prerequisites (`claude`, `agy`, `node`, docker, infra ports)|
| `make infra-up`  | Start only Postgres + Redis in Docker                                  |
| `make infra-down`| Stop the infra containers (data preserved)                             |
| `make infra-restart` | Restart the infra containers                                       |
| `make infra-logs`| Tail the infra container logs                                          |
| `make ps`        | Show container status                                                  |
| `make dev`       | Run the server on the host in dev mode (hot reload)                    |
| `make run`       | Alias for `make dev`                                                    |
| `make start`     | Build + run the production bundle on the host                          |
| `make build`     | Build the production bundle only (no run)                              |
| `make clean`     | `docker compose down` (data volumes preserved)                         |
| `make nuke`      | `docker compose down -v` — **deletes data volumes (destructive)**      |

---

## Production / containerised alternative

If you do **not** need the subscription CLIs (e.g. CI, a Linux server), switch
the two providers to their HTTP API paths instead and run everything in Docker
per [DEPLOYMENT_DOCKER.md](DEPLOYMENT_DOCKER.md):

- Anthropic via API: set `providers.anthropic.mode: "api"` (env
  `MULTI_PROVIDERS_ANTHROPIC_MODE=api`) and provide `ANTHROPIC_API_KEY`.
- Gemini via API: disable Antigravity (`ANTIGRAVITY_ENABLED=false`) and set
  `GOOGLE_API_KEY`.

This trades the zero-token subscription access for billed API usage, but needs
no host binaries.

---

## Troubleshooting

| Symptom                                              | Cause / fix                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `CLI binary "claude" is not installed`               | You're running the server in Docker, or `claude` not on PATH. Run on host; `make doctor`. |
| `Antigravity CLI binary not found`                   | Same as above for `agy`. `agy` cannot run in a Linux container at all.       |
| `... is not logged in` / `unauthorized`              | Run `claude` / `agy` once interactively on the host to authenticate.        |
| Server starts but DB calls fail / MemStorage mode    | `DATABASE_URL` not reaching the app, or `make infra-up` not run. Check `make doctor` ports. |
| `pg :5432 closed`                                    | Run `make infra-up`; confirm `docker-compose.override.yml` publishes 5432.   |
| Port 5050 already in use                             | Change `APP_PORT` in `.env`.                                                 |
