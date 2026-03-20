import { z } from "zod";

export const ConfigSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65535).default(5000),
    nodeEnv: z.enum(["development", "production", "test"]).default("development"),
  }).default({}),
  database: z.object({
    url: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().url().optional(),
    ),
  }).default({}),
  auth: z.object({
    jwtSecret: z.string().min(32).optional(),
    sessionTtlDays: z.number().int().min(1).max(365).default(7),
    bcryptRounds: z.number().int().min(10).max(14).default(12),
  }).default({}),
  providers: z.object({
    anthropic: z.object({ apiKey: z.string().optional() }).default({}),
    google: z.object({ apiKey: z.string().optional() }).default({}),
    xai: z.object({ apiKey: z.string().optional() }).default({}),
    vllm: z.object({ endpoint: z.string().url().optional() }).default({}),
    ollama: z.object({ endpoint: z.string().url().optional() }).default({}),
    lmstudio: z.object({ endpoint: z.string().url().optional() }).default({}),
    tavily: z.object({ apiKey: z.string().optional() }).default({}),
  }).default({}),
  features: z.object({
    sandbox: z.object({
      enabled: z.boolean().default(false),
      maxConcurrent: z.number().int().min(1).max(20).default(3),
      defaultTimeoutSeconds: z.number().int().min(10).max(600).default(120),
    }).default({}),
    privacy: z.object({
      enabled: z.boolean().default(true),
    }).default({}),
    maintenance: z.object({
      enabled: z.boolean().default(false),
      cronSchedule: z.string().default("0 2 * * *"),
    }).default({}),
  }).default({}),
  encryption: z.object({
    key: z.string().min(32).optional(),
  }).default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
