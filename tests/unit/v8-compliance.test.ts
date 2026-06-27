import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Import stubs directly to verify successful compilation and importability
import { SkillLifecycleManager } from "../../server/pipeline/v8_stubs/skill-lifecycle-manager";
import { ContourObservabilityService } from "../../server/pipeline/v8_stubs/contour-observability";
import { ProviderPoolRouter } from "../../server/pipeline/v8_stubs/provider-pool-router";

describe("V8 Compliance Integration Tests", () => {
  const rootDir = path.resolve(__dirname, "../../");

  it("asserts that v8_compliance_report.md exists and contains required terms", () => {
    const reportPath = path.join(rootDir, "v8_compliance_report.md");
    expect(fs.existsSync(reportPath)).toBe(true);

    const content = fs.readFileSync(reportPath, "utf-8");
    expect(content).toContain("Yield");
    expect(content).toContain("ABAC");
    expect(content).toContain("Skill");
  });

  it("asserts that server/pipeline/v8_stubs/ directory contains at least 3 files", () => {
    const stubsDir = path.join(rootDir, "server/pipeline/v8_stubs");
    expect(fs.existsSync(stubsDir)).toBe(true);

    const files = fs.readdirSync(stubsDir);
    const tsFiles = files.filter((f) => f.endsWith(".ts"));
    expect(tsFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("asserts that stub files can be imported and instantiated successfully", () => {
    const manager = new SkillLifecycleManager();
    expect(manager).toBeDefined();
    expect(typeof manager.registerSkill).toBe("function");

    const obs = new ContourObservabilityService();
    expect(obs).toBeDefined();
    expect(typeof obs.recordRun).toBe("function");

    const router = new ProviderPoolRouter();
    expect(router).toBeDefined();
    expect(typeof router.routeRequest).toBe("function");
  });
});
