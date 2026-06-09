/**
 * Unit tests for the Morning Brief query-key contract.
 *
 * The query keys are the cache contract every mutation invalidates against, so
 * they are asserted directly (mirrors practice-cards-hooks.test.ts). Full hook
 * behavior under React lives in Playwright E2E, owned by QA.
 *
 * Mutation behavior is asserted structurally: useRefreshBrief /
 * useUpdateNewsProfile / useNewsFeedback all invalidate `newsKeys.base(ws)`, so
 * we verify that base is a PREFIX of every read key (brief / briefHistory /
 * profile) — i.e. invalidating base actually catches them.
 */
import { describe, it, expect } from "vitest";
import { newsKeys } from "@/hooks/use-news";

const WS = "ws-1";

function isPrefix(prefix: readonly unknown[], full: readonly unknown[]): boolean {
  return prefix.every((part, i) => part === full[i]);
}

describe("newsKeys", () => {
  it("namespaces every key under the workspace news surface", () => {
    const base = ["/api/workspaces", WS, "news"];
    expect(newsKeys.base(WS)).toEqual(base);
    expect(newsKeys.brief(WS).slice(0, 3)).toEqual(base);
    expect(newsKeys.briefHistory(WS, 14, 0).slice(0, 3)).toEqual(base);
    expect(newsKeys.profile(WS).slice(0, 3)).toEqual(base);
  });

  it("tags each read key with its surface segment", () => {
    expect(newsKeys.brief(WS)).toContain("brief");
    expect(newsKeys.briefHistory(WS, 14, 0)).toContain("briefs");
    expect(newsKeys.profile(WS)).toContain("profile");
  });

  it("varies the brief key by filters so distinct filters cache separately", () => {
    const a = newsKeys.brief(WS, { category: "internal" });
    const b = newsKeys.brief(WS, { category: "external" });
    const c = newsKeys.brief(WS, { readState: "unread" });
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
    expect(newsKeys.brief(WS, { date: "2026-06-09" })).not.toEqual(newsKeys.brief(WS));
  });

  it("an empty/undefined filter set produces a stable key", () => {
    expect(newsKeys.brief(WS)).toEqual(newsKeys.brief(WS, undefined));
    expect(newsKeys.brief(WS, {})).toEqual(newsKeys.brief(WS));
  });

  it("varies the history key by limit and offset", () => {
    expect(newsKeys.briefHistory(WS, 14, 0)).not.toEqual(newsKeys.briefHistory(WS, 30, 0));
    expect(newsKeys.briefHistory(WS, 14, 0)).not.toEqual(newsKeys.briefHistory(WS, 14, 14));
  });

  it("scopes keys per workspace", () => {
    expect(newsKeys.brief("ws-a")).not.toEqual(newsKeys.brief("ws-b"));
    expect(newsKeys.profile("ws-a")).not.toEqual(newsKeys.profile("ws-b"));
  });
});

describe("invalidation contract", () => {
  it("base is a prefix of every read key (so invalidating base catches them)", () => {
    const base = newsKeys.base(WS);
    expect(isPrefix(base, newsKeys.brief(WS))).toBe(true);
    expect(isPrefix(base, newsKeys.brief(WS, { category: "internal" }))).toBe(true);
    expect(isPrefix(base, newsKeys.briefHistory(WS, 14, 0))).toBe(true);
    expect(isPrefix(base, newsKeys.profile(WS))).toBe(true);
  });

  it("a different workspace's base does NOT prefix this workspace's keys", () => {
    expect(isPrefix(newsKeys.base("ws-other"), newsKeys.brief(WS))).toBe(false);
  });
});
