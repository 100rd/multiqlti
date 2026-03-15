import { z } from "zod";

export const ConfigSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65535).default(5000),
    nodeEnv: z.enum(["development", "production", "test"]).default("development"),
  }),
  database: z.object({
    url: z.string().url(),
  }),
  auth: z.object({
    jwtSecret: z.string().min(32),
    sessionTtlDays: z.number().int().min(1).max(365).default(7),
    bcryptRounds: z.number().int().min(10).max(14).default(12),
  }),
  providers: z.object({
    anthropic: z.object({ apiKey: z.string().optional() }),
    google: z.object({ apiKey: z.string().optional() }),
    xai: z.object({ apiKey: z.string().optional() }),
    vllm: z.object({ endpoint: z.string().url().optional() }),
    ollama: z.object({ endpoint: z.string().url().optional() }),
  }),
  features: z.object({
    sandbox: z.object({
      enabled: z.boolean().default(false),
      maxConcurrent: z.number().int().min(1).max(20).default(3),
      defaultTimeoutSeconds: z.number().int().min(10).max(600).default(120),
    }),
    privacy: z.object({
      enabled: z.boolean().default(true),
    }),
    maintenance: z.object({
      enabled: z.boolean().default(false),
      cronSchedule: z.string().default("0 2 * * *"),
    }),
  }),
  encryption: z.object({
    key: z.string().min(32).optional(),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
