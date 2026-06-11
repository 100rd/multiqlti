/**
 * Integration tests for GET /api/activity — the read-only Live Activity lens.
 *
 * Covers: 401 unauth; owner sees only their own active runs; non-owner does NOT
 * see others'; ownerless hidden from non-admin; admin sees all + ownerId;
 * each mode classified with the right current-unit + model; the payload is
 * METADATA-ONLY (no transcript/output/decisionText/reasoning/prompt); and the
 * row cap truncates + logs.
 *
 * supertest over MemStorage with stub controllers whose getActiveRunIds() drive
 * the candidate set. No CLI / network / real DB.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import type { Router } from "express";
import { MemStorage } from "../../../server/storage.js";
import { registerActivityRoutes } from "../../../server/routes/activity.js";
import type { ActivityRouteDeps } from "../../../server/routes/activity.js";
import type { User, UserRole } from "../../../shared/types.js";

afterEach(() => vi.restoreAllMocks());

const ORCH_MODELS = {
  planModelSlug: "claude-opus",
  synthesizeModelSlug: "claude-opus",
  proposerModelSlug: "claude-opus",
  criticModelSlug: "gemini-flash",
  judgeModelSlug: "claude-opus",
};

interface BuildOpts {
  userId?: string;
  role?: UserRole;
  noUser?: boolean;
  activePipelineManagerOrch?: string[];
  activeConsensus?: string[];
}

function buildApp(storage: MemStorage, opts: BuildOpts = {}) {
  const deps: ActivityRouteDeps = {
    pipelineController: { getActiveRunIds: () => opts.activePipelineManagerOrch ?? [] },
    consensusController: { getActiveRunIds: () => opts.activeConsensus ?? [] },
    orchestratorModels: ORCH_MODELS,
    consensusClaudeModelSlug: "claude-opus",
  };

  const user: User = {
    id: opts.noUser ? (undefined as unknown as string) : opts.userId ?? "owner",
    email: "a@x.com",
    name: "A",
    isActive: true,
    role: opts.role ?? "user",
    lastLoginAt: null,
    createdAt: new Date(0),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.noUser) req.user = undefined as never;
    else req.user = user;
    next();
  });
  registerActivityRoutes(app as unknown as Router, storage, deps);
  return app;
}

/** Seed a pipeline run + a running stage. Returns the runId. */
async function seedPipeline(
  storage: MemStorage,
  triggeredBy: string | null,
): Promise<string> {
  const run = await storage.createPipelineRun({
    pipelineId: "p1",
    status: "running",
    input: "SECRET TASK TEXT do not leak",
    currentStageIndex: 1,
    startedAt: new Date(),
    triggeredBy,
    dagMode: false,
  });
  await storage.createStageExecution({
    runId: run.id,
    stageIndex: 1,
    teamId: "coding",
    modelSlug: "claude-sonnet",
    status: "running",
    input: { secret: "stage prompt should never appear" },
  });
  return run.id;
}

async function seedOrchestrator(storage: MemStorage, triggeredBy: string): Promise<string> {
  const run = await storage.createPipelineRun({
    pipelineId: "orch1",
    status: "running",
    input: "orchestrator task secret",
    currentStageIndex: 0,
    startedAt: new Date(),
    triggeredBy,
    dagMode: false,
  });
  await storage.createOrchestratorRun({ runId: run.id, task: "secret", status: "executing" });
  await storage.createOrchestratorStep({
    runId: run.id,
    stepIndex: 0,
    type: "debate",
    args: { type: "debate", question: "secret question" },
    status: "running",
  });
  return run.id;
}

async function seedConsensus(storage: MemStorage, triggeredBy: string): Promise<string> {
  const run = await storage.createPipelineRun({
    pipelineId: "cons1",
    status: "running",
    input: "consensus decision secret",
    currentStageIndex: 0,
    startedAt: new Date(),
    triggeredBy,
    dagMode: false,
  });
  await storage.createConsensusRun({
    runId: run.id,
    decisionText: "secret decision text",
    status: "deliberating",
  });
  await storage.createConsensusRound({
    runId: run.id,
    round: 1,
    phase: "review",
    tokensUsed: 0,
  });
  return run.id;
}

async function seedManager(storage: MemStorage, triggeredBy: string): Promise<string> {
  const run = await storage.createPipelineRun({
    pipelineId: "mgr1",
    status: "running",
    input: "manager goal secret",
    currentStageIndex: 0,
    startedAt: new Date(),
    triggeredBy,
    dagMode: false,
  });
  await storage.createManagerIteration({
    runId: run.id,
    iterationNumber: 1,
    decision: {
      action: "dispatch",
      teamId: "development",
      task: "SECRET manager task",
      reasoning: "SECRET reasoning that must not leak",
      iterationNumber: 1,
    },
    tokensUsed: 5,
    decisionDurationMs: 10,
  });
  return run.id;
}

describe("GET /api/activity — auth", () => {
  it("401 when unauthenticated", async () => {
    const storage = new MemStorage();
    const app = buildApp(storage, { noUser: true });
    const res = await request(app).get("/api/activity");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/activity — owner scoping", () => {
  it("owner sees only their own active runs (not others')", async () => {
    const storage = new MemStorage();
    const mine = await seedPipeline(storage, "owner");
    const theirs = await seedPipeline(storage, "someone-else");

    const app = buildApp(storage, {
      userId: "owner",
      role: "user",
      activePipelineManagerOrch: [mine, theirs],
    });
    const res = await request(app).get("/api/activity");
    expect(res.status).toBe(200);
    const ids = res.body.runs.map((r: { runId: string }) => r.runId);
    expect(ids).toEqual([mine]);
    expect(res.body.isAdmin).toBe(false);
  });

  it("ownerless runs are hidden from a non-admin", async () => {
    const storage = new MemStorage();
    const ownerless = await seedPipeline(storage, null);
    const app = buildApp(storage, {
      userId: "owner",
      role: "user",
      activePipelineManagerOrch: [ownerless],
    });
    const res = await request(app).get("/api/activity");
    expect(res.body.runs).toEqual([]);
  });

  it("a non-owner does NOT see another user's run", async () => {
    const storage = new MemStorage();
    const theirs = await seedPipeline(storage, "owner");
    const app = buildApp(storage, {
      userId: "intruder",
      role: "user",
      activePipelineManagerOrch: [theirs],
    });
    const res = await request(app).get("/api/activity");
    expect(res.body.runs).toEqual([]);
  });
});

describe("GET /api/activity — admin scoping", () => {
  it("admin sees ALL active runs (incl. ownerless) with ownerId per row", async () => {
    const storage = new MemStorage();
    const a = await seedPipeline(storage, "owner");
    const b = await seedPipeline(storage, "someone-else");
    const c = await seedPipeline(storage, null);

    const app = buildApp(storage, {
      userId: "boss",
      role: "admin",
      activePipelineManagerOrch: [a, b, c],
    });
    const res = await request(app).get("/api/activity");
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(true);
    expect(res.body.runs).toHaveLength(3);
    const owners = res.body.runs.map((r: { ownerId: string | null }) => r.ownerId).sort();
    expect(owners).toEqual([null, "owner", "someone-else"]);
  });
});

describe("GET /api/activity — mode classification + current unit", () => {
  it("classifies a pipeline run with stage + model", async () => {
    const storage = new MemStorage();
    const id = await seedPipeline(storage, "owner");
    const app = buildApp(storage, { userId: "owner", activePipelineManagerOrch: [id] });
    const res = await request(app).get("/api/activity");
    const row = res.body.runs[0];
    expect(row.mode).toBe("pipeline");
    expect(row.currentUnit.agent).toBe("coding");
    expect(row.currentUnit.modelSlug).toBe("claude-sonnet");
    expect(row.currentUnit.label).toBe("Stage 2");
    expect(row.currentUnit.status).toBe("running");
  });

  it("classifies an orchestrator run with step type + model", async () => {
    const storage = new MemStorage();
    const id = await seedOrchestrator(storage, "owner");
    const app = buildApp(storage, { userId: "owner", activePipelineManagerOrch: [id] });
    const res = await request(app).get("/api/activity");
    const row = res.body.runs[0];
    expect(row.mode).toBe("orchestrator");
    expect(row.currentUnit.agent).toBe("debate");
    expect(row.currentUnit.modelSlug).toBe("claude-opus");
    expect(row.currentUnit.label).toBe("Step 1");
  });

  it("classifies a consensus run with phase + voter model", async () => {
    const storage = new MemStorage();
    const id = await seedConsensus(storage, "owner");
    const app = buildApp(storage, { userId: "owner", activeConsensus: [id] });
    const res = await request(app).get("/api/activity");
    const row = res.body.runs[0];
    expect(row.mode).toBe("consensus");
    expect(row.currentUnit.agent).toBe("voters");
    expect(row.currentUnit.modelSlug).toBeNull(); // review phase = voter roster
    expect(row.currentUnit.label).toBe("Round 1 · review");
  });

  it("classifies a manager run with team + best-effort model", async () => {
    const storage = new MemStorage();
    const id = await seedManager(storage, "owner");
    const app = buildApp(storage, { userId: "owner", activePipelineManagerOrch: [id] });
    const res = await request(app).get("/api/activity");
    const row = res.body.runs[0];
    expect(row.mode).toBe("manager");
    expect(row.currentUnit.agent).toBe("development");
    expect(row.currentUnit.modelSlug).toBe("claude-sonnet"); // SDLC development default
    expect(row.currentUnit.label).toBe("Iteration 1");
  });
});

describe("GET /api/activity — metadata-only (security)", () => {
  it("leaks NO transcript/output/decisionText/reasoning/prompt/task text", async () => {
    const storage = new MemStorage();
    const p = await seedPipeline(storage, "owner");
    const m = await seedManager(storage, "owner");
    const c = await seedConsensus(storage, "owner");
    const o = await seedOrchestrator(storage, "owner");

    const app = buildApp(storage, {
      userId: "owner",
      role: "admin",
      activePipelineManagerOrch: [p, m, o],
      activeConsensus: [c],
    });
    const res = await request(app).get("/api/activity");
    const serialized = JSON.stringify(res.body);

    // No free-text / sensitive field names or values anywhere in the payload.
    for (const banned of [
      "SECRET",
      "decisionText",
      "decision_text",
      "reasoning",
      "transcript",
      "prompt",
      "do not leak",
      "secret question",
    ]) {
      expect(serialized).not.toContain(banned);
    }

    // Positive: each row exposes only the metadata keys.
    for (const row of res.body.runs) {
      expect(Object.keys(row).sort()).toEqual(
        ["currentUnit", "mode", "ownerId", "runId", "startedAt", "status", "title", "workspaceId"].sort(),
      );
      if (row.currentUnit) {
        expect(Object.keys(row.currentUnit).sort()).toEqual(
          ["agent", "label", "modelSlug", "status"].sort(),
        );
      }
    }
  });
});

describe("GET /api/activity — row cap", () => {
  it("truncates + logs when the candidate set exceeds the cap", async () => {
    const storage = new MemStorage();
    const ids: string[] = [];
    for (let i = 0; i < 205; i++) ids.push(await seedPipeline(storage, "owner"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const app = buildApp(storage, {
      userId: "owner",
      role: "user",
      activePipelineManagerOrch: ids,
    });
    const res = await request(app).get("/api/activity");
    expect(res.body.runs.length).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
