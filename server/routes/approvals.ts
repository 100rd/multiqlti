import type { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import { validateQuery } from "../middleware/validate.js";

const PendingApprovalsQuerySchema = z.object({
  pipelineId: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

type PendingApprovalsQuery = z.infer<typeof PendingApprovalsQuerySchema>;

export function registerApprovalRoutes(router: Router, storage: IStorage): void {
  router.get(
    "/api/approvals/pending",
    validateQuery(PendingApprovalsQuerySchema),
    async (req, res) => {
      const { pipelineId, limit, offset } = req.query as unknown as PendingApprovalsQuery;

      const result = await storage.getPendingApprovals({
        pipelineId,
        limit,
        offset,
      });

      res.json({
        approvals: result.rows,
        total: result.total,
      });
    },
  );
}
