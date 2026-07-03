import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT,
  LAYOUT_VERSION,
  loadLayout,
  resetLayout,
  saveLayout,
} from "@/lib/dashboard-layout";

// ─── In-memory localStorage stub (node environment, no jsdom) ───────────────────
class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

const STORAGE_KEY = "stats-dashboard-layout:v1";

function seed(payload: unknown) {
  (globalThis.localStorage as Storage).setItem(STORAGE_KEY, JSON.stringify(payload));
}

beforeEach(() => {
  // Fresh storage per test.
  (globalThis as unknown as { localStorage: Storage }).localStorage =
    new MemoryStorage() as unknown as Storage;
});

describe("dashboard-layout persistence", () => {
  it("returns the default layout when nothing is stored", () => {
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("discards a stored layout whose version does not match (falls back to default)", () => {
    seed({
      version: LAYOUT_VERSION + 99,
      layouts: {
        lg: [{ i: "timeline", x: 6, y: 0, w: 6, h: 4 }],
      },
    });
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("drops unknown/stale widget keys from a same-version layout without throwing", () => {
    seed({
      version: LAYOUT_VERSION,
      layouts: {
        lg: [
          { i: "totals", x: 0, y: 0, w: 12, h: 3 },
          { i: "timeline", x: 0, y: 3, w: 12, h: 7 },
          { i: "by-model", x: 0, y: 10, w: 12, h: 7 },
          { i: "by-workspace", x: 0, y: 17, w: 12, h: 7 },
          { i: "request-log", x: 0, y: 24, w: 12, h: 10 },
          // stale key from a previous app version — must be dropped:
          { i: "legacy-pipeline-runs", x: 0, y: 40, w: 12, h: 4 },
        ],
      },
    });

    let result: ReturnType<typeof loadLayout>;
    expect(() => {
      result = loadLayout();
    }).not.toThrow();

    const keys = result!.lg!.map((item) => item.i);
    expect(keys).not.toContain("legacy-pipeline-runs");
    expect(keys.sort()).toEqual(
      ["by-model", "by-workspace", "request-log", "timeline", "totals"].sort(),
    );
  });

  it("backfills a current widget that is missing from the stored layout", () => {
    seed({
      version: LAYOUT_VERSION,
      layouts: {
        lg: [
          { i: "totals", x: 0, y: 0, w: 12, h: 3 },
          { i: "timeline", x: 0, y: 3, w: 12, h: 7 },
          { i: "by-model", x: 0, y: 10, w: 12, h: 7 },
          // "by-workspace" intentionally missing
          { i: "request-log", x: 0, y: 24, w: 12, h: 10 },
        ],
      },
    });

    const result = loadLayout();
    const workspace = result.lg!.find((item) => item.i === "by-workspace");
    const defaultWorkspace = DEFAULT_LAYOUT.lg!.find(
      (item) => item.i === "by-workspace",
    );

    expect(workspace).toBeDefined();
    // Backfilled from its default position.
    expect(workspace).toEqual(defaultWorkspace);
    // All five widgets are present.
    expect(result.lg!.map((i) => i.i).sort()).toEqual(
      ["by-model", "by-workspace", "request-log", "timeline", "totals"].sort(),
    );
  });

  it("round-trips a valid same-version layout unchanged", () => {
    const custom = {
      lg: [
        { i: "totals", x: 0, y: 0, w: 12, h: 3, minW: 4, minH: 2 },
        { i: "timeline", x: 0, y: 3, w: 6, h: 7, minW: 4, minH: 4 },
        { i: "by-model", x: 6, y: 3, w: 6, h: 7, minW: 4, minH: 3 },
        { i: "by-workspace", x: 0, y: 10, w: 6, h: 7, minW: 4, minH: 3 },
        { i: "request-log", x: 0, y: 17, w: 12, h: 10, minW: 5, minH: 5 },
      ],
    };

    saveLayout(custom);
    expect(loadLayout()).toEqual(custom);
  });

  it("resetLayout clears storage and returns the default", () => {
    saveLayout({ lg: [{ i: "timeline", x: 0, y: 0, w: 6, h: 5 }] });
    const afterReset = resetLayout();
    expect(afterReset).toEqual(DEFAULT_LAYOUT);
    // Subsequent load also yields the default (storage was cleared).
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  // ── Operator acceptance scenario ──────────────────────────────────────────────
  // "Shrink the Timeline widget (w:12 → w:6), move it to the left column, reload →
  //  it stays." This is the persistence contract the acceptance test exercises: the
  //  layout react-grid-layout emits from onLayoutChange is saved verbatim, and a
  //  reload (loadLayout) must return Timeline at exactly the resized + moved
  //  geometry — never snapping back to the default full-width top position.
  describe("operator acceptance: shrink + move Timeline, reload keeps it", () => {
    // The exact `allLayouts` react-grid-layout hands to saveLayout after the
    // operator shrinks Timeline to w:6 and drags it to x:0 in the left column,
    // with by-model pulled up beside it at x:6 — proving two widgets sit side by
    // side (only possible because Timeline is now half width).
    const movedLg = [
      { i: "totals", x: 0, y: 0, w: 12, h: 3, minW: 4, minH: 2 },
      { i: "timeline", x: 0, y: 3, w: 6, h: 7, minW: 4, minH: 4 },
      { i: "by-model", x: 6, y: 3, w: 6, h: 7, minW: 4, minH: 3 },
      { i: "by-workspace", x: 0, y: 10, w: 12, h: 7, minW: 4, minH: 3 },
      { i: "request-log", x: 0, y: 17, w: 12, h: 10, minW: 5, minH: 5 },
    ];

    it("persists the shrunk + moved Timeline across a reload (lg breakpoint)", () => {
      saveLayout({ lg: movedLg });

      const timeline = loadLayout().lg!.find((i) => i.i === "timeline")!;
      expect(timeline).toBeDefined();
      // Shrunk to half width and moved into the left column — and it stays.
      expect(timeline.w).toBe(6);
      expect(timeline.x).toBe(0);
      expect(timeline.y).toBe(3);
      expect(timeline.h).toBe(7);
      // The shrink limits survive too, so the widget can be re-shrunk after reload.
      expect(timeline.minW).toBe(4);
      expect(timeline.minH).toBe(4);
    });

    it("keeps a second widget beside the shrunk Timeline (side-by-side layout survives)", () => {
      saveLayout({ lg: movedLg });

      const loaded = loadLayout().lg!;
      const timeline = loaded.find((i) => i.i === "timeline")!;
      const byModel = loaded.find((i) => i.i === "by-model")!;
      // by-model occupies the right half on the same row → they render side by side.
      expect(timeline.x).toBe(0);
      expect(byModel.x).toBe(6);
      expect(byModel.y).toBe(timeline.y);
      expect(timeline.w + byModel.w).toBe(12);
    });

    it("persists the shrunk + moved Timeline at a NON-lg breakpoint (md)", () => {
      // When the dashboard is viewed below 1200px, react-grid-layout emits the
      // moved layout under the CURRENT breakpoint key (md) alongside lg. reconcile
      // must preserve the md geometry too — there is no breakpoint-key mismatch
      // between what RGL emits (md) and what loadLayout reconciles.
      const movedMd = [
        { i: "totals", x: 0, y: 0, w: 10, h: 3, minW: 4, minH: 2 },
        { i: "timeline", x: 0, y: 3, w: 6, h: 7, minW: 4, minH: 4 },
        { i: "by-model", x: 0, y: 10, w: 10, h: 7, minW: 4, minH: 3 },
        { i: "by-workspace", x: 0, y: 17, w: 10, h: 7, minW: 4, minH: 3 },
        { i: "request-log", x: 0, y: 24, w: 10, h: 10, minW: 5, minH: 5 },
      ];
      saveLayout({ lg: DEFAULT_LAYOUT.lg!, md: movedMd });

      const reloaded = loadLayout();
      // The md breakpoint the operator actually interacted with is preserved…
      const mdTimeline = reloaded.md!.find((i) => i.i === "timeline")!;
      expect(mdTimeline.w).toBe(6);
      expect(mdTimeline.x).toBe(0);
      // …and lg is left untouched (still full-width default).
      const lgTimeline = reloaded.lg!.find((i) => i.i === "timeline")!;
      expect(lgTimeline.w).toBe(12);
    });
  });
});
