import { Router } from "express";
import { z } from "zod";
import { SandboxExecutor } from "../sandbox/executor";
import { SANDBOX_IMAGE_PRESETS } from "@shared/constants";

const executor = new SandboxExecutor();

const testSchema = z.object({
  image: z.string().min(1),
  timeout: z.number().max(60).default(30),
});

export function registerSandboxRoutes(router: Router): void {
  router.get("/api/sandbox/status", async (_req, res) => {
    const available = await executor.isAvailable();
    if (available) {
      res.json({ available: true, version: "docker" });
    } else {
      res.json({ available: false });
    }
  });

  router.get("/api/sandbox/presets", (_req, res) => {
    res.json(SANDBOX_IMAGE_PRESETS);
  });

  router.post("/api/sandbox/test", async (req, res) => {
    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.message });
    }

    const { image, timeout } = parsed.data;

    try {
      const result = await executor.execute(
        {
          enabled: true,
          image,
          command: "echo 'sandbox ok'",
          timeout,
          memoryLimit: "128m",
          cpuLimit: 0.5,
          networkEnabled: false,
          failOnNonZero: true,
        },
        [],
      );

      res.json(result);
    } catch (err) {
      res.status(500).json({ message: (err as Error).message });
    }
  });
}
