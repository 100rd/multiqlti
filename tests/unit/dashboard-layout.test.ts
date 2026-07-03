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
});
