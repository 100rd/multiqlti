/**
 * Unit tests for OmniscienceBoardProvider — the board's MCP client extension.
 *
 * Covers the QA cases:
 *   - happy path for blast_radius / incident_timeline / source_stats,
 *   - input validation BEFORE the call (max_depth bounds, as_of tz-aware UTC,
 *     action_type, alert_id shape),
 *   - boundary validation (Security H2): malformed payload → zod reject; arrays
 *     are bounded with `.max()` (impacted/events) — oversize payload rejects,
 *   - Omniscience error-envelope propagation (forbidden / entity_not_found /
 *     invalid_alert_id / source_not_found) without swallowing,
 *   - C2: affects[] are sourced ONLY from blast_radius.impacted.
 */
import { describe, it, expect } from "vitest";
import {
  OmniscienceBoardProvider,
  MAX_IMPACTED,
  MAX_EVENTS,
} from "../../../server/memory/omniscience-board-provider";
import { makeMockBoardCaller } from "../../helpers/mock-omniscience-board";

describe("OmniscienceBoardProvider.blastRadius — happy path + args", () => {
  it("returns parsed, bounded impacted entities", async () => {
    const mock = makeMockBoardCaller();
    const provider = new OmniscienceBoardProvider(mock.caller);
    const res = await provider.blastRadius({ entityId: "payments-api" });
    expect(res.seedEntityId).toBe("payments-api");
    expect(res.impacted.length).toBe(2);
    expect(res.impacted[0].entityId).toBe("payments-api");
    expect(res.impacted[0].impactScore).toBeCloseTo(0.8);
  });

  it("builds contract args (defaults restart / depth 3) and forwards as_of", async () => {
    const mock = makeMockBoardCaller();
    const provider = new OmniscienceBoardProvider(mock.caller);
    await provider.blastRadius({ entityId: "x", asOf: "2026-06-09T05:00:00Z" });
    const call = mock.lastCall();
    expect(call?.toolName).toBe("blast_radius");
    expect(call?.args).toMatchObject({
      entity_id: "x",
      action_type: "restart",
      max_depth: 3,
      as_of: "2026-06-09T05:00:00Z",
    });
  });

  it("passes an explicit action_type and max_depth through", async () => {
    const mock = makeMockBoardCaller();
    const provider = new OmniscienceBoardProvider(mock.caller);
    await provider.blastRadius({ entityId: "x", actionType: "delete", maxDepth: 5 });
    expect(mock.lastCall()?.args).toMatchObject({ action_type: "delete", max_depth: 5 });
  });
});

describe("OmniscienceBoardProvider.blastRadius — input validation BEFORE call", () => {
  it("rejects max_depth below 1 without calling the tool", async () => {
    const mock = makeMockBoardCaller();
    const provider = new OmniscienceBoardProvider(mock.caller);
    await expect(provider.blastRadius({ entityId: "x", maxDepth: 0 })).rejects.toThrow();
    expect(mock.lastCall()).toBeNull();
  });

  it("rejects max_depth above 5 without calling the tool", async () => {
    const mock = makeMockBoardCaller();
    const provider = new OmniscienceBoardProvider(mock.caller);
    await expect(provider.blastRadius({ entityId: "x", maxDepth: 6 })).rejects.toThrow();
    expect(mock.lastCall()).toBeNull();
  });

  it("rejects a naive (non-UTC) as_of without calling the tool", async () => {
    const mock = makeMockBoardCaller();
    const provider = new OmniscienceBoardProvider(mock.caller);
    await expect(
      provider.blastRadius({ entityId: "x", asOf: "2026-06-09T05:00:00" }),
    ).rejects.toThrow();
    expect(mock.lastCall()).toBeNull();
  });

  it("rejects an empty entityId", async () => {
    const mock = makeMockBoardCaller();
    const provider = new OmniscienceBoardProvider(mock.caller);
    await expect(provider.blastRadius({ entityId: "  " })).rejects.toThrow();
    expect(mock.lastCall()).toBeNull();
  });
});

describe("OmniscienceBoardProvider.blastRadius — boundary validation (H2)", () => {
  it("rejects a malformed (non-contract) payload", async () => {
    const mock = makeMockBoardCaller({ returnMalformed: true });
    const provider = new OmniscienceBoardProvider(mock.caller);
    await expect(provider.blastRadius({ entityId: "x" })).rejects.toThrow();
  });

  it("rejects an oversize impacted[] beyond MAX_IMPACTED", async () => {
    const mock = makeMockBoardCaller({ oversize: MAX_IMPACTED + 1 });
    const provider = new OmniscienceBoardProvider(mock.caller);
    await expect(provider.blastRadius({ entityId: "x" })).rejects.toThrow();
  });

  it("accepts impacted[] exactly at MAX_IMPACTED", async () => {
    const mock = makeMockBoardCaller({ oversize: MAX_IMPACTED });
    const provider = new OmniscienceBoardProvider(mock.caller);
    const res = await provider.blastRadius({ entityId: "x" });
    expect(res.impacted.length).toBe(MAX_IMPACTED);
  });
});

describe("OmniscienceBoardProvider.blastRadius — error-envelope propagation", () => {
  it("propagates forbidden from an unscoped token", async () => {
    const mock = makeMockBoardCaller({ unscopedToken: true });
    const provider = new OmniscienceBoardProvider(mock.caller);
    await expect(provider.blastRadius({ entityId: "x" })).rejects.toThrow(/forbidden/);
  });

  it("propagates entity_not_found", async () => {
    const mock = makeMockBoardCaller();
    const provider = new OmniscienceBoardProvider(mock.caller);
    await expect(provider.blastRadius({ entityId: "__missing__" })).rejects.toThrow(/entity_not_found/);
  });
});

describe("OmniscienceBoardProvider.incidentTimeline", () => {
  it("returns parsed, bounded events on the happy path", async () => {
    const mock = makeMockBoardCaller();
    const provider = new OmniscienceBoardProvider(mock.caller);
    const res = await provider.incidentTimeline({ alertId: "alert://pd/123" });
    expect(res.alertId).toBe("alert://pd/123");
    expect(res.events.length).toBe(1);
    expect(res.events[0].changeKind).toBe("created");
  });

  it("rejects a malformed alert_id BEFORE calling the tool", async () => {
    const mock = makeMockBoardCaller();
    const provider = new OmniscienceBoardProvider(mock.caller);
    await expect(provider.incidentTimeline({ alertId: "not-an-alert" })).rejects.toThrow();
    expect(mock.lastCall()).toBeNull();
  });

  it("propagates forbidden from an unscoped token", async () => {
    const mock = makeMockBoardCaller({ unscopedToken: true });
    const provider = new OmniscienceBoardProvider(mock.caller);
    await expect(provider.incidentTimeline({ alertId: "alert://pd/1" })).rejects.toThrow(/forbidden/);
  });

  it("rejects oversize events[] beyond MAX_EVENTS", async () => {
    const mock = makeMockBoardCaller({ oversize: MAX_EVENTS + 1 });
    const provider = new OmniscienceBoardProvider(mock.caller);
    await expect(provider.incidentTimeline({ alertId: "alert://pd/1" })).rejects.toThrow();
  });
});

describe("OmniscienceBoardProvider.sourceStats", () => {
  it("returns parsed freshness stats", async () => {
    const mock = makeMockBoardCaller();
    const provider = new OmniscienceBoardProvider(mock.caller);
    const res = await provider.sourceStats("src-1");
    expect(res.id).toBe("src-1");
    expect(res.isStale).toBe(false);
    expect(res.indexedDocumentCount).toBe(120);
  });

  it("propagates source_not_found", async () => {
    const mock = makeMockBoardCaller();
    const provider = new OmniscienceBoardProvider(mock.caller);
    await expect(provider.sourceStats("__missing__")).rejects.toThrow(/source_not_found/);
  });

  it("rejects a malformed stats payload", async () => {
    const mock = makeMockBoardCaller({ returnMalformed: true });
    const provider = new OmniscienceBoardProvider(mock.caller);
    await expect(provider.sourceStats("src-1")).rejects.toThrow();
  });
});

describe("C2 — affects come ONLY from blast_radius.impacted", () => {
  it("toAffects maps impacted rows into the BlastAffect shape", async () => {
    const mock = makeMockBoardCaller({
      impacted: [
        {
          entity_id: "svc",
          entity_type: "service",
          dependency_path: [{ from_entity: "a", to_entity: "svc", edge_type: "DEPENDS_ON" }],
          impact_score: 0.7,
          confidence: 0.9,
        },
      ],
    });
    const provider = new OmniscienceBoardProvider(mock.caller);
    const res = await provider.blastRadius({ entityId: "svc" });
    const affects = provider.toAffects(res);
    expect(affects).toEqual([
      {
        entityId: "svc",
        entityType: "service",
        impactScore: 0.7,
        confidence: 0.9,
        path: [{ fromEntity: "a", toEntity: "svc", edgeType: "DEPENDS_ON" }],
      },
    ]);
  });
});
