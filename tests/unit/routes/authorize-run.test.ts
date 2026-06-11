/**
 * Unit tests for the shared authorizeRun helper (server/routes/authorize-run.ts).
 *
 * Parity with the prior inline copies in routes/orchestrator.ts + routes/consensus.ts:
 *   - 401 takes precedence over existence (unauth → 401 even for a real run),
 *   - 404 when the run (or the required mode row) is missing,
 *   - 403 for a non-owner non-admin,
 *   - DENY when triggeredBy == null for non-admins (stricter rule),
 *   - admin sees everything (incl. ownerless),
 *   - owner sees their own run.
 * On success returns { ownerId }; on failure sends the status and returns null.
 */
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { authorizeRun } from "../../../server/routes/authorize-run.js";

interface FakeRun {
  id: string;
  triggeredBy: string | null;
}

function makeRes(): { res: Response; statusCalls: number[]; jsonBodies: unknown[] } {
  const statusCalls: number[] = [];
  const jsonBodies: unknown[] = [];
  const res = {
    status(code: number) {
      statusCalls.push(code);
      return this;
    },
    json(body: unknown) {
      jsonBodies.push(body);
      return this;
    },
  } as unknown as Response;
  return { res, statusCalls, jsonBodies };
}

function makeReq(user?: { id?: string; role?: string }): Request {
  return { user } as unknown as Request;
}

function makeStorage(run: FakeRun | undefined, modeRow?: unknown) {
  return {
    getPipelineRun: vi.fn(async () => run),
    getModeRow: vi.fn(async () => modeRow),
  };
}

describe("authorizeRun", () => {
  it("401 when unauthenticated (precedence over existence)", async () => {
    const storage = makeStorage({ id: "r1", triggeredBy: "owner" });
    const { res, statusCalls } = makeRes();
    const out = await authorizeRun(makeReq(undefined), res, storage as never, "r1");
    expect(out).toBeNull();
    expect(statusCalls).toEqual([401]);
  });

  it("404 when the pipeline run is missing", async () => {
    const storage = makeStorage(undefined);
    const { res, statusCalls } = makeRes();
    const out = await authorizeRun(makeReq({ id: "u1", role: "user" }), res, storage as never, "missing");
    expect(out).toBeNull();
    expect(statusCalls).toEqual([404]);
  });

  it("404 when the run exists but the required mode row is missing", async () => {
    const storage = makeStorage({ id: "r1", triggeredBy: "u1" }, undefined);
    const { res, statusCalls } = makeRes();
    const out = await authorizeRun(
      makeReq({ id: "u1", role: "user" }),
      res,
      storage as never,
      "r1",
      { requireModeRow: (s, id) => s.getModeRow(id) },
    );
    expect(out).toBeNull();
    expect(statusCalls).toEqual([404]);
  });

  it("403 for a non-owner non-admin", async () => {
    const storage = makeStorage({ id: "r1", triggeredBy: "owner" });
    const { res, statusCalls } = makeRes();
    const out = await authorizeRun(makeReq({ id: "intruder", role: "user" }), res, storage as never, "r1");
    expect(out).toBeNull();
    expect(statusCalls).toEqual([403]);
  });

  it("403 (deny) when triggeredBy == null for a non-admin", async () => {
    const storage = makeStorage({ id: "r1", triggeredBy: null });
    const { res, statusCalls } = makeRes();
    const out = await authorizeRun(makeReq({ id: "u1", role: "user" }), res, storage as never, "r1");
    expect(out).toBeNull();
    expect(statusCalls).toEqual([403]);
  });

  it("allows the owner and returns their ownerId", async () => {
    const storage = makeStorage({ id: "r1", triggeredBy: "u1" });
    const { res, statusCalls } = makeRes();
    const out = await authorizeRun(makeReq({ id: "u1", role: "user" }), res, storage as never, "r1");
    expect(statusCalls).toEqual([]);
    expect(out).toEqual({ ownerId: "u1" });
  });

  it("allows an admin to see another user's run", async () => {
    const storage = makeStorage({ id: "r1", triggeredBy: "owner" });
    const { res, statusCalls } = makeRes();
    const out = await authorizeRun(makeReq({ id: "boss", role: "admin" }), res, storage as never, "r1");
    expect(statusCalls).toEqual([]);
    expect(out).toEqual({ ownerId: "owner" });
  });

  it("allows an admin to see an ownerless run", async () => {
    const storage = makeStorage({ id: "r1", triggeredBy: null });
    const { res, statusCalls } = makeRes();
    const out = await authorizeRun(makeReq({ id: "boss", role: "admin" }), res, storage as never, "r1");
    expect(statusCalls).toEqual([]);
    expect(out).toEqual({ ownerId: null });
  });

  it("mode row present passes through to the authz gate (owner)", async () => {
    const storage = makeStorage({ id: "r1", triggeredBy: "u1" }, { exists: true });
    const { res, statusCalls } = makeRes();
    const out = await authorizeRun(
      makeReq({ id: "u1", role: "user" }),
      res,
      storage as never,
      "r1",
      { requireModeRow: (s, id) => s.getModeRow(id) },
    );
    expect(statusCalls).toEqual([]);
    expect(out).toEqual({ ownerId: "u1" });
  });
});
