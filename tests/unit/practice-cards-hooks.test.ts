/**
 * Unit tests for the practice-card query-key contract.
 *
 * The query keys are the cache contract every mutation invalidates against, so
 * they are asserted directly. (Full hook behavior under React lives in
 * Playwright E2E, owned by QA — see the QA notes.)
 */
import { describe, it, expect } from "vitest";
import { practiceCardKeys } from "@/hooks/use-practice-cards";

const WS = "ws-1";

describe("practiceCardKeys", () => {
  it("namespaces every key under the workspace knowledge surface", () => {
    const base = ["/api/workspaces", WS, "knowledge", "practice-cards"];
    expect(practiceCardKeys.list(WS).slice(0, 4)).toEqual(base);
    expect(practiceCardKeys.search(WS, "q", 5).slice(0, 4)).toEqual(base);
    expect(practiceCardKeys.refreshRun(WS, "run-1").slice(0, 4)).toEqual(base);
    expect(practiceCardKeys.compliance(WS).slice(0, 4)).toEqual(base);
  });

  it("includes filters in the list key so distinct filters cache separately", () => {
    const a = practiceCardKeys.list(WS, { status: "active" });
    const b = practiceCardKeys.list(WS, { status: "superseded" });
    expect(a).not.toEqual(b);
    expect(practiceCardKeys.list(WS)).toContain("list");
  });

  it("varies the search key by query and topK", () => {
    expect(practiceCardKeys.search(WS, "a", 5)).not.toEqual(
      practiceCardKeys.search(WS, "b", 5),
    );
    expect(practiceCardKeys.search(WS, "a", 5)).not.toEqual(
      practiceCardKeys.search(WS, "a", 10),
    );
  });

  it("keys a refresh run by its run id", () => {
    expect(practiceCardKeys.refreshRun(WS, "run-1")).toContain("run-1");
    expect(practiceCardKeys.refreshRun(WS, "run-1")).toContain("refresh-run");
  });
});
