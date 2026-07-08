// ─── Dashboard layout persistence (localStorage, versioned) ────────────────────
//
// The Statistics dashboard is a Grafana-like grid of repositionable/resizable
// widgets powered by react-grid-layout. This module owns the *versioned* schema
// used to persist the per-browser layout in localStorage, plus the reconciliation
// logic that keeps a stored layout safe to apply even when the set of widgets has
// changed since it was written (widget added, removed, or renamed).
//
// Design guarantees:
//   1. Version mismatch  → stored layout is discarded, DEFAULT_LAYOUT is used.
//   2. Unknown widget key → dropped from the applied layout (never crashes).
//   3. Missing widget     → filled in from its default position.
//   4. Same-version, complete layout → round-trips unchanged.

import type { Layout, LayoutItem, ResponsiveLayouts } from "react-grid-layout/legacy";

// Bump whenever the DEFAULT_LAYOUT shape or widget set changes incompatibly.
// Task #52.2: bumped 1 → 2 for the new "loop-trust" widget. Any layout persisted
// under the old version is discarded (guarantee #1 below), never crashes.
export const LAYOUT_VERSION = 2;

const STORAGE_KEY = "stats-dashboard-layout:v1";

// ─── Widget registry ──────────────────────────────────────────────────────────
// The canonical list of widget keys currently rendered on the dashboard. A layout
// entry whose `i` is not in this set is considered stale/unknown and is dropped.
export type WidgetKey =
  | "totals"
  | "timeline"
  | "by-model"
  | "by-workspace"
  | "request-log"
  | "loop-trust";

export const WIDGET_KEYS: readonly WidgetKey[] = [
  "totals",
  "timeline",
  "by-model",
  "by-workspace",
  "request-log",
  "loop-trust",
];

function isKnownWidget(key: string): key is WidgetKey {
  return (WIDGET_KEYS as readonly string[]).includes(key);
}

// ─── Default layout ─────────────────────────────────────────────────────────────
// Only the `lg` breakpoint is defined explicitly; react-grid-layout's Responsive
// component derives the other breakpoints from it. The vertical stacking mirrors
// the pre-dashboard page order: Totals → Timeline → Per-Model → Per-Workspace →
// Request Log. Grid is 12 columns at `lg`.
//
// minW=4 on Timeline (and the tables) means a widget can be shrunk to a third of
// the width and moved into a left column — i.e. the operator can shrink Timeline
// to ~half width (w6) and drag it to x:0, placing another widget beside it.
export const DEFAULT_LAYOUT: ResponsiveLayouts = {
  lg: [
    { i: "totals", x: 0, y: 0, w: 12, h: 3, minW: 4, minH: 2 },
    { i: "timeline", x: 0, y: 3, w: 12, h: 7, minW: 4, minH: 4 },
    { i: "by-model", x: 0, y: 10, w: 12, h: 7, minW: 4, minH: 3 },
    { i: "by-workspace", x: 0, y: 17, w: 12, h: 7, minW: 4, minH: 3 },
    { i: "request-log", x: 0, y: 24, w: 12, h: 10, minW: 5, minH: 5 },
    { i: "loop-trust", x: 0, y: 34, w: 12, h: 5, minW: 4, minH: 3 },
  ],
};

interface StoredLayout {
  version: number;
  layouts: ResponsiveLayouts;
}

// ─── Storage access (SSR/Node/private-mode safe) ───────────────────────────────
function getStorage(): Storage | undefined {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Access can throw in some privacy modes — treat as "no storage".
  }
  return undefined;
}

function cloneLayouts(layouts: ResponsiveLayouts): ResponsiveLayouts {
  return JSON.parse(JSON.stringify(layouts)) as ResponsiveLayouts;
}

function defaultLayouts(): ResponsiveLayouts {
  return cloneLayouts(DEFAULT_LAYOUT);
}

// ─── Type guards for untrusted stored data ─────────────────────────────────────
function isStoredLayout(value: unknown): value is StoredLayout {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.version === "number" &&
    typeof obj.layouts === "object" &&
    obj.layouts !== null
  );
}

function isLayoutItem(value: unknown): value is LayoutItem {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.i === "string" &&
    typeof obj.x === "number" &&
    typeof obj.y === "number" &&
    typeof obj.w === "number" &&
    typeof obj.h === "number"
  );
}

function findDefaultItem(
  key: WidgetKey,
  breakpointDefaults: Layout,
): LayoutItem | undefined {
  return (
    breakpointDefaults.find((item) => item.i === key) ??
    DEFAULT_LAYOUT.lg?.find((item) => item.i === key)
  );
}

// Reconcile a single breakpoint's items: drop unknown keys, dedupe, preserve the
// stored order of known items, then append any missing current widgets from their
// default positions. Never throws.
function reconcileBreakpoint(items: Layout, breakpointDefaults: Layout): Layout {
  const knownByKey = new Map<string, LayoutItem>();
  for (const item of items) {
    if (isKnownWidget(item.i)) knownByKey.set(item.i, item); // last wins on dup
  }

  const result: LayoutItem[] = [];
  const seen = new Set<string>();

  // Preserve first-appearance order of known items.
  for (const item of items) {
    if (isKnownWidget(item.i) && !seen.has(item.i)) {
      result.push(knownByKey.get(item.i)!);
      seen.add(item.i);
    }
  }

  // Ensure every current widget has an entry.
  for (const key of WIDGET_KEYS) {
    if (!seen.has(key)) {
      const fallback = findDefaultItem(key, breakpointDefaults);
      if (fallback) {
        result.push(fallback);
        seen.add(key);
      }
    }
  }

  return result;
}

function reconcile(stored: ResponsiveLayouts): ResponsiveLayouts {
  const breakpoints = new Set<string>(Object.keys(stored));
  breakpoints.add("lg"); // `lg` must always exist so Responsive can derive others.

  const out: Record<string, Layout> = {};
  for (const bp of breakpoints) {
    const raw = stored[bp];
    const items: Layout = Array.isArray(raw) ? raw.filter(isLayoutItem) : [];
    const breakpointDefaults = DEFAULT_LAYOUT[bp] ?? DEFAULT_LAYOUT.lg ?? [];
    out[bp] = reconcileBreakpoint(items, breakpointDefaults);
  }
  return out;
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Load the persisted layout, falling back to (a clone of) DEFAULT_LAYOUT on any of:
 * missing storage, unparseable JSON, wrong shape, or version mismatch. A valid
 * same-version layout is reconciled against the current widget set so stale keys
 * are dropped and missing widgets are backfilled — it never crashes the page.
 */
export function loadLayout(): ResponsiveLayouts {
  const storage = getStorage();
  const raw = storage?.getItem(STORAGE_KEY);
  if (!raw) return defaultLayouts();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultLayouts();
  }

  if (!isStoredLayout(parsed)) return defaultLayouts();
  if (parsed.version !== LAYOUT_VERSION) return defaultLayouts();

  return reconcile(parsed.layouts);
}

/** Persist the given layouts under the current schema version. Best-effort. */
export function saveLayout(layouts: ResponsiveLayouts): void {
  const storage = getStorage();
  if (!storage) return;
  const payload: StoredLayout = { version: LAYOUT_VERSION, layouts };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota/serialization failures are non-fatal for a per-browser convenience.
  }
}

/** Clear the persisted layout and return a fresh clone of the default. */
export function resetLayout(): ResponsiveLayouts {
  const storage = getStorage();
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  return defaultLayouts();
}
