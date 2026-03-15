import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireRole, requireOwnerOrRole } from "../../server/auth/middleware.js";
import type { User } from "../../shared/types.js";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "user@example.com",
    name: "Test User",
    isActive: true,
    role: "user",
    lastLoginAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeReq(user?: User): Partial<Request> {
  return { user } as Partial<Request>;
}

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; _statusCode: number } {
  const res: Record<string, unknown> = {};
  res.json = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockImplementation((code: number) => {
    (res as Record<string, unknown>)._statusCode = code;
    return res;
  });
  return res as unknown as ReturnType<typeof makeRes>;
}

// ─── requireRole ──────────────────────────────────────────────────────────────

describe("requireRole", () => {
  it("calls next() when user has the required role", () => {
    const req = makeReq(makeUser({ role: "admin" }));
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    requireRole("admin")(req as Request, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("calls next() when user has any of the required roles", () => {
    const req = makeReq(makeUser({ role: "maintainer" }));
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    requireRole("maintainer", "admin")(req as Request, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 403 when user lacks the required role", () => {
    const req = makeReq(makeUser({ role: "user" }));
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    requireRole("admin")(req as Request, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 401 when no user is attached to request", () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    requireRole("admin")(req as Request, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("allows maintainer when only maintainer is required", () => {
    const req = makeReq(makeUser({ role: "maintainer" }));
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    requireRole("maintainer")(req as Request, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("blocks user role from maintainer-only routes", () => {
    const req = makeReq(makeUser({ role: "user" }));
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    requireRole("maintainer", "admin")(req as Request, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ─── requireOwnerOrRole ───────────────────────────────────────────────────────

describe("requireOwnerOrRole", () => {
  it("calls next() when user is the resource owner", () => {
    const userId = "user-1";
    const req = makeReq(makeUser({ id: userId, role: "user" }));
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    requireOwnerOrRole(() => userId, "admin")(req as Request, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() when user has a qualifying role even if not the owner", () => {
    const req = makeReq(makeUser({ id: "user-2", role: "admin" }));
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    requireOwnerOrRole(() => "user-1", "admin")(req as Request, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 403 when user is neither owner nor has role", () => {
    const req = makeReq(makeUser({ id: "user-2", role: "user" }));
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    requireOwnerOrRole(() => "user-1", "admin")(req as Request, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 403 when ownerId is null and user lacks role", () => {
    const req = makeReq(makeUser({ id: "user-1", role: "user" }));
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    requireOwnerOrRole(() => null, "admin")(req as Request, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 401 when no user is attached to request", () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    requireOwnerOrRole(() => "user-1", "admin")(req as Request, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("allows maintainer role in addition to admin", () => {
    const req = makeReq(makeUser({ id: "user-2", role: "maintainer" }));
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    requireOwnerOrRole(() => "user-1", "maintainer", "admin")(
      req as Request,
      res as unknown as Response,
      next,
    );

    expect(next).toHaveBeenCalledOnce();
  });
});
