import { z } from "zod";

/**
 * Zod schema for `multiqlti.yaml` — the per-repo project config file.
 * All fields are optional; only those present in the file are applied.
 */
export const ProjectConfigSchema = z.object({
  name: z.string().max(200).optional(),

  defaults: z
    .object({
      tokenBudget: z.number().min(0.1).max(1.0).optional(),
      stageTimeout: z.number().int().min(5000).max(3_600_000).optional(),
      retryPolicy: z
        .object({
          maxRetries: z.number().int().min(0).max(10).optional(),
          backoffMs: z.number().int().min(100).max(30_000).optional(),
        })
        .optional(),
    })
    .optional(),

  privacy: z
    .object({
      enabled: z.boolean().optional(),
      categories: z.array(z.string()).optional(),
      customPatterns: z
        .array(
          z.object({
            name: z.string(),
            pattern: z.string(),
            replacement: z.string(),
          }),
        )
        .optional(),
    })
    .optional(),

  maintenance: z
    .object({
      enabled: z.boolean().optional(),
      schedule: z.string().optional(),
      severityThreshold: z.enum(["low", "medium", "high", "critical"]).optional(),
      categories: z
        .array(
          z.object({
            category: z.string(),
            enabled: z.boolean().optional(),
            severity: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),

  environment: z.record(z.string()).optional(),

  requiredVars: z
    .array(
      z.object({
        key: z.string().min(1),
        description: z.string().optional(),
        secret: z.boolean().default(false),
      }),
    )
    .optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
