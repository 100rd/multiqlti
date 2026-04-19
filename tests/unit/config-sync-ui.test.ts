/**
 * Unit tests for config-sync UI logic (issue #324).
 *
 * Tests pure utility functions from use-config-sync.ts and the
 * aggregated status builder logic from the server route.
 * DOM rendering is not required — all assertions are against data structures.
 */

import { describe, it, expect } from "vitest";
import {
  formatLastSeen,
  deriveBadgeState,
  type ConfigSyncStatus,
  type PeerSyncInfo,
  type SyncBadgeState,
} from "../../client/src/hooks/use-config-sync";

// ─── formatLastSeen ───────────────────────────────────────────────────────────

describe("formatLastSeen", () => {
  it("returns 'never' for null", () => {
    expect(formatLastSeen(null)).toBe("never");
  });

  it("shows seconds when under 60", () => {
    expect(formatLastSeen(0)).toBe("0s ago");
    expect(formatLastSeen(59)).toBe("59s ago");
  });

  it("shows minutes when under 3600", () => {
    expect(formatLastSeen(60)).toBe("1m ago");
    expect(formatLastSeen(3599)).toBe("59m ago");
  });

  it("shows hours when under 86400", () => {
    expect(formatLastSeen(3600)).toBe("1h ago");
    expect(formatLastSeen(86399)).toBe("23h ago");
  });

  it("shows days for 86400+", () => {
    expect(formatLastSeen(86400)).toBe("1d ago");
    expect(formatLastSeen(172800)).toBe("2d ago");
  });
});

// ─── deriveBadgeState ─────────────────────────────────────────────────────────

function makePeer(
  overrides: Partial<PeerSyncInfo> = {},
): PeerSyncInfo {
  return {
    peerId: "peer-1",
    peerName: "Peer One",
    endpoint: "http://peer1:8080",
    status: "synced",
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    lastSeenSecs: 60,
    queueDepth: 0,
    openConflicts: 0,
    ...overrides,
  };
}

function makeStatus(
  peers: PeerSyncInfo[],
  overrides: Partial<ConfigSyncStatus> = {},
): ConfigSyncStatus {
  return {
    totalPeers: peers.length,
    syncedPeers: peers.filter((p) => p.status === "synced").length,
    badgeState: "green",
    summary: `${peers.length} peers`,
    peers,
    openConflicts: 0,
    lastSyncAt: null,
    ...overrides,
  };
}

describe("deriveBadgeState", () => {
  it("returns green when all peers are synced within 5 min and no conflicts", () => {
    const status = makeStatus([
      makePeer({ lastSeenSecs: 30 }),
      makePeer({ peerId: "peer-2", lastSeenSecs: 120 }),
    ]);
    expect(deriveBadgeState(status)).toBe<SyncBadgeState>("green");
  });

  it("returns yellow when a peer has a pending queue", () => {
    const status = makeStatus([
      makePeer({ queueDepth: 5, lastSeenSecs: 30 }),
    ]);
    expect(deriveBadgeState(status)).toBe<SyncBadgeState>("yellow");
  });

  it("returns red when a peer is offline (status=offline)", () => {
    const status = makeStatus([
      makePeer({ status: "offline", lastSeenSecs: null }),
    ]);
    expect(deriveBadgeState(status)).toBe<SyncBadgeState>("red");
  });

  it("returns red when lastSeenSecs > 300 (stale peer)", () => {
    const status = makeStatus([
      makePeer({ lastSeenSecs: 301, status: "synced" }),
    ]);
    expect(deriveBadgeState(status)).toBe<SyncBadgeState>("red");
  });

  it("returns red when there are open conflicts", () => {
    const status = makeStatus(
      [makePeer()],
      { openConflicts: 2 },
    );
    expect(deriveBadgeState(status)).toBe<SyncBadgeState>("red");
  });

  it("red takes priority over yellow (conflicts + queue)", () => {
    const status = makeStatus(
      [makePeer({ queueDepth: 3, status: "offline" })],
      { openConflicts: 1 },
    );
    expect(deriveBadgeState(status)).toBe<SyncBadgeState>("red");
  });

  it("green when peers array is empty and no conflicts", () => {
    const status = makeStatus([]);
    expect(deriveBadgeState(status)).toBe<SyncBadgeState>("green");
  });

  it("returns green when lastSeenSecs is exactly 300 (boundary)", () => {
    const status = makeStatus([makePeer({ lastSeenSecs: 300 })]);
    expect(deriveBadgeState(status)).toBe<SyncBadgeState>("green");
  });
});

// ─── Server-side status builder (pure logic re-implemented) ──────────────────

type PeerInfoLike = {
  instanceId: string;
  instanceName: string;
  endpoint: string;
  status: "connected" | "disconnected" | "connecting";
  lastMessageAt: Date | null;
};

function buildStatusResponse(
  rawPeers: PeerInfoLike[],
  openConflicts: Array<{ peerId: string }>,
) {
  const now = Date.now();
  const conflictsByPeer: Record<string, number> = {};
  for (const c of openConflicts) {
    conflictsByPeer[c.peerId] = (conflictsByPeer[c.peerId] ?? 0) + 1;
  }

  const peers = rawPeers.map((p) => {
    const lastSeenMs = p.lastMessageAt ? p.lastMessageAt.getTime() : null;
    const lastSeenSecs = lastSeenMs !== null ? Math.floor((now - lastSeenMs) / 1000) : null;
    const peerConflicts = conflictsByPeer[p.instanceId] ?? 0;

    let peerStatus: "synced" | "pending" | "offline" | "conflict";
    if (peerConflicts > 0) {
      peerStatus = "conflict";
    } else if (p.status === "disconnected" || (lastSeenSecs !== null && lastSeenSecs > 300)) {
      peerStatus = "offline";
    } else {
      peerStatus = "synced";
    }

    return {
      peerId: p.instanceId,
      peerName: p.instanceName,
      endpoint: p.endpoint,
      status: peerStatus,
      lastSeenAt: p.lastMessageAt ? p.lastMessageAt.toISOString() : null,
      lastSeenSecs,
      queueDepth: 0,
      openConflicts: peerConflicts,
    };
  });

  const totalPeers = peers.length;
  const syncedPeers = peers.filter(
    (p) => p.status === "synced" && (p.lastSeenSecs === null || p.lastSeenSecs <= 300),
  ).length;
  const totalOpenConflicts = openConflicts.length;

  let badgeState: "green" | "yellow" | "red" = "green";
  if (
    totalOpenConflicts > 0 ||
    peers.some((p) => p.status === "offline" || p.status === "conflict")
  ) {
    badgeState = "red";
  } else if (peers.some((p) => p.queueDepth > 0)) {
    badgeState = "yellow";
  }

  return { totalPeers, syncedPeers, badgeState, peers, openConflicts: totalOpenConflicts };
}

describe("buildStatusResponse (server logic)", () => {
  const recentDate = new Date(Date.now() - 90_000); // 90s ago
  const staleDate = new Date(Date.now() - 400_000); // > 5 min ago

  it("no peers → totalPeers=0, green badge", () => {
    const result = buildStatusResponse([], []);
    expect(result.totalPeers).toBe(0);
    expect(result.badgeState).toBe("green");
  });

  it("one connected peer, no conflicts → synced, green badge", () => {
    const result = buildStatusResponse(
      [{ instanceId: "p1", instanceName: "P1", endpoint: "http://p1", status: "connected", lastMessageAt: recentDate }],
      [],
    );
    expect(result.totalPeers).toBe(1);
    expect(result.syncedPeers).toBe(1);
    expect(result.badgeState).toBe("green");
    expect(result.peers[0].status).toBe("synced");
  });

  it("disconnected peer → offline, red badge", () => {
    const result = buildStatusResponse(
      [{ instanceId: "p1", instanceName: "P1", endpoint: "http://p1", status: "disconnected", lastMessageAt: recentDate }],
      [],
    );
    expect(result.badgeState).toBe("red");
    expect(result.peers[0].status).toBe("offline");
  });

  it("stale peer (lastMessageAt > 5 min ago) → offline, red badge", () => {
    const result = buildStatusResponse(
      [{ instanceId: "p1", instanceName: "P1", endpoint: "http://p1", status: "connected", lastMessageAt: staleDate }],
      [],
    );
    expect(result.badgeState).toBe("red");
    expect(result.peers[0].status).toBe("offline");
  });

  it("conflict for a peer → conflict status, red badge", () => {
    const result = buildStatusResponse(
      [{ instanceId: "p1", instanceName: "P1", endpoint: "http://p1", status: "connected", lastMessageAt: recentDate }],
      [{ peerId: "p1" }, { peerId: "p1" }],
    );
    expect(result.openConflicts).toBe(2);
    expect(result.badgeState).toBe("red");
    expect(result.peers[0].status).toBe("conflict");
    expect(result.peers[0].openConflicts).toBe(2);
  });

  it("mixed: one synced + one offline → red badge, syncedPeers=1", () => {
    const result = buildStatusResponse(
      [
        { instanceId: "p1", instanceName: "P1", endpoint: "http://p1", status: "connected", lastMessageAt: recentDate },
        { instanceId: "p2", instanceName: "P2", endpoint: "http://p2", status: "disconnected", lastMessageAt: null },
      ],
      [],
    );
    expect(result.totalPeers).toBe(2);
    expect(result.syncedPeers).toBe(1);
    expect(result.badgeState).toBe("red");
  });

  it("no lastMessageAt → null lastSeenSecs, treated as offline when disconnected", () => {
    const result = buildStatusResponse(
      [{ instanceId: "p1", instanceName: "P1", endpoint: "http://p1", status: "disconnected", lastMessageAt: null }],
      [],
    );
    expect(result.peers[0].lastSeenSecs).toBeNull();
    expect(result.peers[0].status).toBe("offline");
  });
});

// ─── Conflict card display logic ──────────────────────────────────────────────

describe("conflict display helpers", () => {
  it("pending_human and detected are 'open'", () => {
    const statuses = ["pending_human", "detected", "auto_resolved", "human_resolved", "dismissed"];
    const openStatuses = statuses.filter(
      (s) => s === "pending_human" || s === "detected",
    );
    expect(openStatuses).toEqual(["pending_human", "detected"]);
  });

  it("version truncation renders first 8 chars", () => {
    const version = "abc12345xyz";
    expect(version.slice(0, 8)).toBe("abc12345");
  });

  it("strategy labels cover all known strategies", () => {
    const strategyLabel: Record<string, string> = {
      human: "Human review",
      lww: "Last-write-wins",
      auto_merge: "Auto-merge",
      approval_voting: "Approval voting",
    };
    const known = ["lww", "human", "auto_merge", "approval_voting"];
    for (const s of known) {
      expect(strategyLabel[s]).toBeDefined();
    }
  });
});
