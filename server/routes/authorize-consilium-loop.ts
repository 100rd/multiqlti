/**
 * authorize-consilium-loop.ts — owner-or-admin authorization for a CONSILIUM
 * LOOP, keyed on `consilium_loops.createdBy` (design §7 / §13 M-1).
 *
 * DELIBERATE DEVIATION from `authorize-task-group.ts` (which returns 403 on an
 * owner mismatch): this guard returns **404** on a non-visible loop — the
 * STRONGER posture (M-1 picks 404 over 403). A loop reveals an allowlisted
 * `repoPath` + commit shas, so we do not even confirm the loop EXISTS to a
 * non-owner: a missing loop and a foreign loop are indistinguishable (no
 * enumeration oracle). The deviation is intentional and applied consistently to
 * every per-id loop route.
 *
 * Ordering: 401 unauth → 404 (missing OR not-visible). Admin bypass via
 * `isVisible`. Ownerless loops (createdBy == null, creator deleted) are visible
 * to admins only, so an admin can still cancel them (L-3).
 *
 * On success returns { loop, ownerId }; on failure it writes the status + a
 * generic body to `res` and returns null (the caller MUST early-return).
 */
import type { Request, Response } from "express";
import type { IStorage } from "../storage.js";
import type { ConsiliumLoopRow } from "@shared/schema";
import { isVisible } from "./authorize-run.js";

export interface AuthorizedConsiliumLoop {
  loop: ConsiliumLoopRow;
  /** The loop owner id (consilium_loops.createdBy); null for ownerless (admin-only). */
  ownerId: string | null;
}

export async function authorizeConsiliumLoop(
  req: Request,
  res: Response,
  storage: IStorage,
  loopId: string,
): Promise<AuthorizedConsiliumLoop | null> {
  // 401 first — unauth takes precedence over existence.
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }

  const loop = await storage.getLoop(loopId);
  // M-1: 404 for BOTH missing and not-visible — no existence oracle to non-owners.
  if (!loop || !isVisible(loop.createdBy, req.user)) {
    res.status(404).json({ error: "Consilium loop not found" });
    return null;
  }

  return { loop, ownerId: loop.createdBy };
}
