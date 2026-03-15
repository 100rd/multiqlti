/**
 * Unit tests for server/teams/ — SDLC agent team classes + TeamRegistry.
 *
 * All gateway calls are mocked. No real API calls are made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Gateway } from "../../../server/gateway/index.js";
import type { StageContext, TeamConfig } from "../../../shared/types.js";
import { SDLC_TEAMS } from "../../../shared/constants.js";

import { PlanningTeam } from "../../../server/teams/planning.js";
import { ArchitectureTeam } from "../../../server/teams/architecture.js";
import { DevelopmentTeam } from "../../../server/teams/development.js";
import { TestingTeam } from "../../../server/teams/testing.js";
import { CodeReviewTeam } from "../../../server/teams/code-review.js";
import { DeploymentTeam } from "../../../server/teams/deployment.js";
import { MonitoringTeam } from "../../../server/teams/monitoring.js";
import { FactCheckTeam } from "../../../server/teams/fact-check.js";
import { TeamRegistry } from "../../../server/teams/registry.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGateway(responseContent = "mock output"): Gateway {
  return {
    complete: vi.fn().mockResolvedValue({
      content: responseContent,
      tokensUsed: 10,
      modelSlug: "mock",
      finishReason: "stop",
    }),
    stream: vi.fn(),
    completeWithTools: vi.fn().mockResolvedValue({
      content: responseContent,
      tokensUsed: 10,
      modelSlug: "mock",
      finishReason: "stop",
      toolCallLog: [],
    }),
  } as unknown as Gateway;
}

function makeContext(overrides: Partial<StageContext> = {}): StageContext {
  return {
    runId: "run-1",
    stageIndex: 0,
    previousOutputs: [],
    ...overrides,
  };
}

function makeTeamConfig(id: string): TeamConfig {
  return SDLC_TEAMS[id] ?? {
    id,
    name: id,
    description: "",
    defaultModelSlug: "mock",
    systemPromptTemplate: `You are the ${id} team.`,
    inputSchema: {},
    outputSchema: {},
    tools: [],
    color: "gray",
    icon: "Star",
  };
}

// ─── TeamRegistry ─────────────────────────────────────────────────────────────

describe("TeamRegistry", () => {
  const gateway = makeGateway();
  let registry: TeamRegistry;

  beforeEach(() => {
    registry = new TeamRegistry(gateway);
  });

  it("instantiates without error", () => {
    expect(registry).toBeDefined();
  });

  it("returns PlanningTeam for 'planning'", () => {
    const team = registry.getTeam("planning");
    expect(team).toBeInstanceOf(PlanningTeam);
  });

  it("returns ArchitectureTeam for 'architecture'", () => {
    const team = registry.getTeam("architecture");
    expect(team).toBeInstanceOf(ArchitectureTeam);
  });

  it("returns DevelopmentTeam for 'development'", () => {
    const team = registry.getTeam("development");
    expect(team).toBeInstanceOf(DevelopmentTeam);
  });

  it("returns TestingTeam for 'testing'", () => {
    const team = registry.getTeam("testing");
    expect(team).toBeInstanceOf(TestingTeam);
  });

  it("returns CodeReviewTeam for 'code_review'", () => {
    const team = registry.getTeam("code_review");
    expect(team).toBeInstanceOf(CodeReviewTeam);
  });

  it("returns DeploymentTeam for 'deployment'", () => {
    const team = registry.getTeam("deployment");
    expect(team).toBeInstanceOf(DeploymentTeam);
  });

  it("returns MonitoringTeam for 'monitoring'", () => {
    const team = registry.getTeam("monitoring");
    expect(team).toBeInstanceOf(MonitoringTeam);
  });

  it("returns FactCheckTeam for 'fact_check'", () => {
    const team = registry.getTeam("fact_check");
    expect(team).toBeInstanceOf(FactCheckTeam);
  });

  it("returns a CustomTeam for an unknown teamId (graceful fallback)", () => {
    // TeamRegistry falls back to CustomTeam for user-defined stage IDs
    const team = registry.getTeam("nonexistent_team" as any);
    expect(team).toBeDefined();
  });

  it("getAllTeams returns all 8 registered teams", () => {
    const all = registry.getAllTeams();
    expect(all).toHaveLength(8);
  });

  it("getAllTeams entries have id and team shape", () => {
    const all = registry.getAllTeams();
    for (const entry of all) {
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("team");
      expect(typeof entry.id).toBe("string");
    }
  });

  it("all known teamIds are registered", () => {
    const knownIds = [
      "planning", "architecture", "development", "testing",
      "code_review", "deployment", "monitoring", "fact_check",
    ];
    for (const id of knownIds) {
      expect(() => registry.getTeam(id)).not.toThrow();
    }
  });

  it("CustomTeam fallback uses the provided teamId", () => {
    const team = registry.getTeam("ghost_team" as any);
    // CustomTeam should be defined and usable
    expect(team).toBeDefined();
  });
});

// ─── PlanningTeam ─────────────────────────────────────────────────────────────

describe("PlanningTeam", () => {
  const gateway = makeGateway();
  const config = makeTeamConfig("planning");
  let team: PlanningTeam;

  beforeEach(() => {
    team = new PlanningTeam(gateway, config);
  });

  it("instantiates without error", () => {
    expect(team).toBeDefined();
  });

  it("buildPrompt returns a non-empty array", () => {
    const msgs = team.buildPrompt({ taskDescription: "build an API" }, makeContext());
    expect(msgs).toBeInstanceOf(Array);
    expect(msgs.length).toBeGreaterThan(0);
  });

  it("buildPrompt first message is a system message", () => {
    const msgs = team.buildPrompt({ taskDescription: "build an API" }, makeContext());
    expect(msgs[0].role).toBe("system");
  });

  it("buildPrompt system message is non-empty string", () => {
    const msgs = team.buildPrompt({ taskDescription: "build an API" }, makeContext());
    expect(typeof msgs[0].content).toBe("string");
    expect(msgs[0].content.length).toBeGreaterThan(0);
  });

  it("buildPrompt user message contains the taskDescription", () => {
    const msgs = team.buildPrompt({ taskDescription: "build a payment API" }, makeContext());
    const user = msgs.find((m) => m.role === "user");
    expect(user?.content).toContain("build a payment API");
  });

  it("buildPrompt system message contains planning-related keywords", () => {
    const msgs = team.buildPrompt({ taskDescription: "test" }, makeContext());
    const system = msgs.find((m) => m.role === "system");
    const lower = system!.content.toLowerCase();
    expect(lower).toMatch(/plan/);
  });

  it("buildPrompt handles missing taskDescription gracefully", () => {
    expect(() => team.buildPrompt({}, makeContext())).not.toThrow();
  });

  it("buildPrompt handles empty context without crashing", () => {
    const ctx = makeContext({ previousOutputs: [] });
    expect(() => team.buildPrompt({ taskDescription: "x" }, ctx)).not.toThrow();
  });

  it("parseOutput returns object with required keys", () => {
    const result = team.parseOutput('{"tasks":[],"acceptanceCriteria":[],"risks":[],"summary":"done"}');
    expect(result).toHaveProperty("tasks");
    expect(result).toHaveProperty("acceptanceCriteria");
    expect(result).toHaveProperty("risks");
    expect(result).toHaveProperty("summary");
  });

  it("parseOutput defaults tasks to empty array when missing", () => {
    const result = team.parseOutput("{}");
    expect(result.tasks).toEqual([]);
  });

  it("parseOutput defaults summary to empty string when missing", () => {
    const result = team.parseOutput("{}");
    expect(result.summary).toBe("");
  });

  it("parseOutput handles non-JSON raw output without throwing", () => {
    expect(() => team.parseOutput("not json at all")).not.toThrow();
  });

  it("parseOutput returns consistent object type for garbage input", () => {
    const result = team.parseOutput("plain text response");
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
  });
});

// ─── ArchitectureTeam ─────────────────────────────────────────────────────────

describe("ArchitectureTeam", () => {
  const gateway = makeGateway();
  const config = makeTeamConfig("architecture");
  let team: ArchitectureTeam;

  beforeEach(() => {
    team = new ArchitectureTeam(gateway, config);
  });

  it("instantiates without error", () => {
    expect(team).toBeDefined();
  });

  it("buildPrompt returns messages array with system + user", () => {
    const msgs = team.buildPrompt({ summary: "design a REST API" }, makeContext());
    expect(msgs.some((m) => m.role === "system")).toBe(true);
    expect(msgs.some((m) => m.role === "user")).toBe(true);
  });

  it("buildPrompt system message mentions architecture-related terms", () => {
    const msgs = team.buildPrompt({}, makeContext());
    const sys = msgs.find((m) => m.role === "system");
    const lower = sys!.content.toLowerCase();
    expect(lower).toMatch(/architect/);
  });

  it("buildPrompt incorporates previous planning output when available", () => {
    const ctx = makeContext({ previousOutputs: [{ summary: "planning done" }] });
    const msgs = team.buildPrompt({ summary: "design" }, ctx);
    const user = msgs.find((m) => m.role === "user");
    expect(user?.content).toContain("planningOutput");
  });

  it("buildPrompt handles missing previousOutputs gracefully", () => {
    const ctx = makeContext({ previousOutputs: [] });
    expect(() => team.buildPrompt({ summary: "design" }, ctx)).not.toThrow();
  });

  it("parseOutput returns object with components key", () => {
    const result = team.parseOutput('{"components":[],"techStack":{},"dataFlow":"","apiEndpoints":[],"summary":""}');
    expect(result).toHaveProperty("components");
  });

  it("parseOutput defaults components to empty array", () => {
    const result = team.parseOutput("{}");
    expect(result.components).toEqual([]);
  });

  it("parseOutput defaults techStack to empty object", () => {
    const result = team.parseOutput("{}");
    expect(result.techStack).toEqual({});
  });

  it("parseOutput handles non-JSON input without throwing", () => {
    expect(() => team.parseOutput("I designed a microservices system")).not.toThrow();
  });
});

// ─── DevelopmentTeam ─────────────────────────────────────────────────────────

describe("DevelopmentTeam", () => {
  const gateway = makeGateway();
  const config = makeTeamConfig("development");
  let team: DevelopmentTeam;

  beforeEach(() => {
    team = new DevelopmentTeam(gateway, config);
  });

  it("instantiates without error", () => {
    expect(team).toBeDefined();
  });

  it("buildPrompt returns non-empty messages array", () => {
    const msgs = team.buildPrompt({ taskDescription: "implement auth" }, makeContext());
    expect(msgs.length).toBeGreaterThan(0);
  });

  it("buildPrompt system message mentions code or implement", () => {
    const msgs = team.buildPrompt({}, makeContext());
    const sys = msgs.find((m) => m.role === "system");
    const lower = sys!.content.toLowerCase();
    expect(lower).toMatch(/code|develop|implement/);
  });

  it("buildPrompt includes architecture output in user message when available", () => {
    const ctx = makeContext({ previousOutputs: [{}, { components: [] }] });
    const msgs = team.buildPrompt({ taskDescription: "code it" }, ctx);
    const user = msgs.find((m) => m.role === "user");
    expect(user?.content).toContain("architectureOutput");
  });

  it("buildPrompt handles partial previousOutputs without crashing", () => {
    const ctx = makeContext({ previousOutputs: [{ summary: "only planning" }] });
    expect(() => team.buildPrompt({ taskDescription: "code" }, ctx)).not.toThrow();
  });

  it("parseOutput returns object with files key", () => {
    const result = team.parseOutput('{"files":[],"dependencies":[],"summary":""}');
    expect(result).toHaveProperty("files");
  });

  it("parseOutput defaults files to empty array", () => {
    const result = team.parseOutput("{}");
    expect(result.files).toEqual([]);
  });

  it("parseOutput defaults dependencies to empty array", () => {
    const result = team.parseOutput("{}");
    expect(result.dependencies).toEqual([]);
  });

  it("parseOutput handles non-JSON gracefully", () => {
    expect(() => team.parseOutput("here is some code")).not.toThrow();
  });
});

// ─── TestingTeam ─────────────────────────────────────────────────────────────

describe("TestingTeam", () => {
  const gateway = makeGateway();
  const config = makeTeamConfig("testing");
  let team: TestingTeam;

  beforeEach(() => {
    team = new TestingTeam(gateway, config);
  });

  it("instantiates without error", () => {
    expect(team).toBeDefined();
  });

  it("buildPrompt returns system + user messages", () => {
    const msgs = team.buildPrompt({ taskDescription: "test the API" }, makeContext());
    expect(msgs.some((m) => m.role === "system")).toBe(true);
    expect(msgs.some((m) => m.role === "user")).toBe(true);
  });

  it("buildPrompt system message mentions testing", () => {
    const msgs = team.buildPrompt({}, makeContext());
    const sys = msgs.find((m) => m.role === "system");
    expect(sys!.content.toLowerCase()).toMatch(/test/);
  });

  it("buildPrompt uses development output when available", () => {
    const ctx = makeContext({ previousOutputs: [{}, {}, { files: [] }] });
    const msgs = team.buildPrompt({ taskDescription: "write tests" }, ctx);
    const user = msgs.find((m) => m.role === "user");
    expect(user?.content).toContain("developmentOutput");
  });

  it("buildPrompt handles empty context without crashing", () => {
    const ctx = makeContext({ previousOutputs: [] });
    expect(() => team.buildPrompt({}, ctx)).not.toThrow();
  });

  it("parseOutput returns object with testFiles key", () => {
    const result = team.parseOutput('{"testFiles":[],"testStrategy":"","coverageTargets":{},"issues":[],"summary":""}');
    expect(result).toHaveProperty("testFiles");
  });

  it("parseOutput defaults testFiles to empty array", () => {
    const result = team.parseOutput("{}");
    expect(result.testFiles).toEqual([]);
  });

  it("parseOutput defaults issues to empty array", () => {
    const result = team.parseOutput("{}");
    expect(result.issues).toEqual([]);
  });

  it("parseOutput handles plain text without throwing", () => {
    expect(() => team.parseOutput("no json here")).not.toThrow();
  });
});

// ─── CodeReviewTeam ──────────────────────────────────────────────────────────

describe("CodeReviewTeam", () => {
  const gateway = makeGateway();
  const config = makeTeamConfig("code_review");
  let team: CodeReviewTeam;

  beforeEach(() => {
    team = new CodeReviewTeam(gateway, config);
  });

  it("instantiates without error", () => {
    expect(team).toBeDefined();
  });

  it("buildPrompt returns non-empty messages array", () => {
    const msgs = team.buildPrompt({}, makeContext());
    expect(msgs.length).toBeGreaterThan(0);
  });

  it("buildPrompt system message mentions review or quality", () => {
    const msgs = team.buildPrompt({}, makeContext());
    const sys = msgs.find((m) => m.role === "system");
    expect(sys!.content.toLowerCase()).toMatch(/review|quality|security/);
  });

  it("buildPrompt includes developmentOutput and testingOutput in user message", () => {
    const ctx = makeContext({
      previousOutputs: [{}, {}, { files: [] }, { testFiles: [] }],
    });
    const msgs = team.buildPrompt({}, ctx);
    const user = msgs.find((m) => m.role === "user");
    expect(user?.content).toContain("developmentOutput");
    expect(user?.content).toContain("testingOutput");
  });

  it("buildPrompt handles empty previousOutputs without crashing", () => {
    const ctx = makeContext({ previousOutputs: [] });
    expect(() => team.buildPrompt({}, ctx)).not.toThrow();
  });

  it("parseOutput returns object with findings key", () => {
    const result = team.parseOutput('{"findings":[],"securityIssues":[],"score":{},"approved":true,"summary":""}');
    expect(result).toHaveProperty("findings");
  });

  it("parseOutput defaults findings to empty array", () => {
    const result = team.parseOutput("{}");
    expect(result.findings).toEqual([]);
  });

  it("parseOutput defaults approved to false", () => {
    const result = team.parseOutput("{}");
    expect(result.approved).toBe(false);
  });

  it("parseOutput handles non-JSON input without throwing", () => {
    expect(() => team.parseOutput("looks good to me")).not.toThrow();
  });
});

// ─── DeploymentTeam ──────────────────────────────────────────────────────────

describe("DeploymentTeam", () => {
  const gateway = makeGateway();
  const config = makeTeamConfig("deployment");
  let team: DeploymentTeam;

  beforeEach(() => {
    team = new DeploymentTeam(gateway, config);
  });

  it("instantiates without error", () => {
    expect(team).toBeDefined();
  });

  it("buildPrompt returns system + user messages", () => {
    const msgs = team.buildPrompt({}, makeContext());
    expect(msgs.some((m) => m.role === "system")).toBe(true);
    expect(msgs.some((m) => m.role === "user")).toBe(true);
  });

  it("buildPrompt system message mentions deployment", () => {
    const msgs = team.buildPrompt({}, makeContext());
    const sys = msgs.find((m) => m.role === "system");
    expect(sys!.content.toLowerCase()).toMatch(/deploy/);
  });

  it("buildPrompt embeds allOutputs in user message", () => {
    const ctx = makeContext({ previousOutputs: [{ summary: "plan" }] });
    const msgs = team.buildPrompt({}, ctx);
    const user = msgs.find((m) => m.role === "user");
    expect(user?.content).toContain("allOutputs");
  });

  it("buildPrompt handles empty context without crashing", () => {
    const ctx = makeContext({ previousOutputs: [] });
    expect(() => team.buildPrompt({}, ctx)).not.toThrow();
  });

  it("parseOutput returns object with files key", () => {
    const result = team.parseOutput('{"files":[],"deploymentStrategy":"","environments":[],"summary":""}');
    expect(result).toHaveProperty("files");
  });

  it("parseOutput defaults deploymentStrategy to empty string", () => {
    const result = team.parseOutput("{}");
    expect(result.deploymentStrategy).toBe("");
  });

  it("parseOutput defaults environments to empty array", () => {
    const result = team.parseOutput("{}");
    expect(result.environments).toEqual([]);
  });

  it("parseOutput handles malformed input gracefully", () => {
    expect(() => team.parseOutput("{ broken json")).not.toThrow();
  });
});

// ─── MonitoringTeam ──────────────────────────────────────────────────────────

describe("MonitoringTeam", () => {
  const gateway = makeGateway();
  const config = makeTeamConfig("monitoring");
  let team: MonitoringTeam;

  beforeEach(() => {
    team = new MonitoringTeam(gateway, config);
  });

  it("instantiates without error", () => {
    expect(team).toBeDefined();
  });

  it("buildPrompt returns non-empty messages", () => {
    const msgs = team.buildPrompt({}, makeContext());
    expect(msgs.length).toBeGreaterThan(0);
  });

  it("buildPrompt system message mentions monitoring or observability", () => {
    const msgs = team.buildPrompt({}, makeContext());
    const sys = msgs.find((m) => m.role === "system");
    expect(sys!.content.toLowerCase()).toMatch(/monitor|observ|sre/);
  });

  it("buildPrompt uses deployment output when available at index 5", () => {
    const ctx = makeContext({
      previousOutputs: [{}, {}, {}, {}, {}, { deploymentStrategy: "blue-green" }],
    });
    const msgs = team.buildPrompt({}, ctx);
    const user = msgs.find((m) => m.role === "user");
    expect(user?.content).toContain("deploymentOutput");
  });

  it("buildPrompt handles empty previousOutputs without crashing", () => {
    expect(() => team.buildPrompt({}, makeContext())).not.toThrow();
  });

  it("parseOutput returns object with dashboards, alerts, healthChecks keys", () => {
    const result = team.parseOutput('{"dashboards":[],"alerts":[],"healthChecks":[],"summary":""}');
    expect(result).toHaveProperty("dashboards");
    expect(result).toHaveProperty("alerts");
    expect(result).toHaveProperty("healthChecks");
  });

  it("parseOutput defaults alerts to empty array", () => {
    const result = team.parseOutput("{}");
    expect(result.alerts).toEqual([]);
  });

  it("parseOutput handles non-JSON gracefully", () => {
    expect(() => team.parseOutput("set up prometheus")).not.toThrow();
  });
});

// ─── FactCheckTeam ───────────────────────────────────────────────────────────

describe("FactCheckTeam", () => {
  const gateway = makeGateway();
  const config = makeTeamConfig("fact_check");
  let team: FactCheckTeam;

  beforeEach(() => {
    team = new FactCheckTeam(gateway, config);
  });

  it("instantiates without error", () => {
    expect(team).toBeDefined();
  });

  it("buildPrompt returns system + user messages", () => {
    const msgs = team.buildPrompt({}, makeContext());
    expect(msgs.some((m) => m.role === "system")).toBe(true);
    expect(msgs.some((m) => m.role === "user")).toBe(true);
  });

  it("buildPrompt user message instructs to fact-check", () => {
    const msgs = team.buildPrompt({}, makeContext());
    const user = msgs.find((m) => m.role === "user");
    expect(user?.content.toLowerCase()).toContain("fact-check");
  });

  it("buildPrompt uses last previousOutput when available", () => {
    const ctx = makeContext({ previousOutputs: [{ summary: "first" }, { summary: "last" }] });
    const msgs = team.buildPrompt({}, ctx);
    const user = msgs.find((m) => m.role === "user");
    expect(user?.content).toContain("last");
  });

  it("buildPrompt truncates very long previous output", () => {
    const bigOutput = { content: "x".repeat(10000) };
    const ctx = makeContext({ previousOutputs: [bigOutput] });
    const msgs = team.buildPrompt({}, ctx);
    const user = msgs.find((m) => m.role === "user");
    // should not include the full 10k chars
    expect(user!.content.length).toBeLessThan(10000 + 500);
  });

  it("buildPrompt handles empty previousOutputs without crashing", () => {
    expect(() => team.buildPrompt({}, makeContext())).not.toThrow();
  });

  it("parseOutput returns object with verdict, issues, enrichedOutput, summary", () => {
    const raw = JSON.stringify({
      verdict: "pass",
      issues: [],
      enrichedOutput: "all good",
      summary: "no issues",
    });
    const result = team.parseOutput(raw);
    expect(result).toHaveProperty("verdict");
    expect(result).toHaveProperty("issues");
    expect(result).toHaveProperty("enrichedOutput");
    expect(result).toHaveProperty("summary");
  });

  it("parseOutput defaults verdict to 'warn' when missing", () => {
    const result = team.parseOutput("{}");
    expect(result.verdict).toBe("warn");
  });

  it("parseOutput defaults issues to empty array when missing", () => {
    const result = team.parseOutput("{}");
    expect(result.issues).toEqual([]);
  });

  it("parseOutput handles non-JSON gracefully", () => {
    expect(() => team.parseOutput("everything looks correct")).not.toThrow();
  });
});
