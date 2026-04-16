import { configLoader } from "./config/loader";

// Load and validate configuration before anything else.
// process.exit(1) is called inside load() if validation fails.
const config = configLoader.load();

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { runMigrations } from "./db";
import { serveStatic } from "./static";
import { createServer } from "http";
import { FederationManager } from "./federation/index";
import { setFederationManager, getFederationManager } from "./federation/manager-state";

const app = express();
app.disable("x-powered-by");
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, unknown> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson as Record<string, unknown>;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

// Re-export getFederationManager for backward compatibility with any external consumers.
export { getFederationManager };

(async () => {
  // Reject API requests with path traversal sequences
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.includes("..")) {
      return res.status(400).json({ error: "Invalid path" });
    }
    next();
  });

  // Apply pending database migrations before starting the server
  await runMigrations();

  await registerRoutes(httpServer, app);

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const e = err as { status?: number; statusCode?: number; message?: string };
    const status = e.status ?? e.statusCode ?? 500;
    const message = e.message ?? "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // Catch-all for unmatched /api/* routes -- return JSON 404 instead of SPA HTML
  app.all("/api/{*path}", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not Found" });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (config.server.nodeEnv === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // Start federation if enabled
  if (config.federation.enabled) {
    const federationManager = new FederationManager({
      enabled: config.federation.enabled,
      instanceId: config.federation.instanceId,
      instanceName: config.federation.instanceName,
      clusterSecret: config.federation.clusterSecret,
      listenPort: config.federation.listenPort,
      peers: config.federation.peers,
      encryption: config.federation.encryption,
    });
    setFederationManager(federationManager);
    await federationManager.start();
    log(`federation started on port ${config.federation.listenPort} (instance: ${config.federation.instanceId})`, "federation");
  }

  // Serve both the API and the client on the configured port.
  const { port } = config.server;
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      ...(config.server.nodeEnv === "production" && { reusePort: true }),
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
