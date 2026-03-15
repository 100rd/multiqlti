import { WebSocketServer, WebSocket } from "ws";
import type { Server, IncomingMessage } from "http";
import type { WsEvent } from "@shared/types";
import { authService } from "../auth/service";

function extractTokenFromRequest(req: IncomingMessage): string | null {
  const url = req.url ?? "";
  const queryMatch = url.match(/[?&]token=([^&]+)/);
  if (queryMatch) return decodeURIComponent(queryMatch[1]);

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  return null;
}

export class WsManager {
  private wss: WebSocketServer;
  private subscriptions: Map<string, Set<WebSocket>>;

  constructor(httpServer: Server) {
    this.wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    this.subscriptions = new Map();

    this.wss.on("connection", async (ws, req) => {
      const token = extractTokenFromRequest(req);
      if (!token) {
        ws.close(4001, "Unauthorized");
        return;
      }

      const user = await authService.validateToken(token);
      if (!user) {
        ws.close(4001, "Unauthorized");
        return;
      }

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            type: string;
            runId?: string;
          };

          if (msg.type === "subscribe" && msg.runId) {
            this.subscribe(ws, msg.runId);
          }
          if (msg.type === "unsubscribe" && msg.runId) {
            this.unsubscribe(ws, msg.runId);
          }
        } catch {
          // ignore malformed messages
        }
      });

      ws.on("close", () => {
        this.removeClient(ws);
      });
    });
  }

  subscribe(ws: WebSocket, runId: string): void {
    let clients = this.subscriptions.get(runId);
    if (!clients) {
      clients = new Set();
      this.subscriptions.set(runId, clients);
    }
    clients.add(ws);
  }

  unsubscribe(ws: WebSocket, runId: string): void {
    const clients = this.subscriptions.get(runId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) this.subscriptions.delete(runId);
    }
  }

  private removeClient(ws: WebSocket): void {
    for (const [runId, clients] of this.subscriptions) {
      clients.delete(ws);
      if (clients.size === 0) this.subscriptions.delete(runId);
    }
  }

  broadcastToRun(runId: string, event: WsEvent): void {
    const clients = this.subscriptions.get(runId);
    if (!clients) return;
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  broadcastGlobal(event: WsEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  getConnectionCount(): number {
    return this.wss.clients.size;
  }
}
