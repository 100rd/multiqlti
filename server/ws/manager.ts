import { WebSocketServer, WebSocket } from "ws";
import type { Server, IncomingMessage } from "http";
import type { WsEvent, User } from "@shared/types";
import type { IStorage } from "../storage";
import { authService } from "../auth/service";
import { runAsSystem } from "../context";
import { isVisible } from "../routes/authorize-run.js";

function extractTokenFromRequest(req: IncomingMessage): string | null {
  const url = req.url ?? "";
  const queryMatch = url.match(/[?&]token=([^&]+)/);
  if (queryMatch) return decodeURIComponent(queryMatch[1]);

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  return null;
}

/** A socket that carries its authenticated user (set on connection). */
type AuthedSocket = WebSocket & { user?: User };

export class WsManager {
  private wss: WebSocketServer;
  private subscriptions: Map<string, Set<WebSocket>>;
  private storage?: IStorage;

  /**
   * @param storage Optional storage used to enforce per-run ownership on
   *   `subscribe` messages (IDOR hardening). When omitted (e.g. some unit
   *   tests), the low-level subscribe registry still works but the ownership
   *   gate cannot resolve a run → it fails closed (denies).
   */
  constructor(httpServer: Server, storage?: IStorage) {
    this.wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    this.subscriptions = new Map();
    this.storage = storage;

    this.wss.on("connection", async (ws: AuthedSocket, req) => {
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
      // Pin the authed user to the socket so subscribe can authorize per-run.
      ws.user = user;

      ws.on("message", (data) => {
        let msg: { type: string; runId?: string };
        try {
          msg = JSON.parse(data.toString()) as { type: string; runId?: string };
        } catch {
          // ignore malformed messages
          return;
        }

        if (msg.type === "subscribe" && msg.runId) {
          // IDOR hardening: a socket may only subscribe to a run it owns (or
          // any run if admin). Async ownership check; never throws to the loop.
          void this.authorizeAndSubscribe(ws, ws.user, msg.runId).catch(() => {
            /* fail closed — never crash the socket on an authz error */
          });
        }
        if (msg.type === "unsubscribe" && msg.runId) {
          this.unsubscribe(ws, msg.runId);
        }
      });

      ws.on("close", () => {
        this.removeClient(ws);
      });
    });
  }

  /**
   * Ownership-gated subscribe (the only path the live socket uses). `runId`
   * names a task_groups.id — owner via task_groups.createdBy (H3).
   *
   * Ownerless rows are denied to non-admins (the strict isVisible posture);
   * an unknown id fails closed. Returns whether it subscribed.
   */
  async authorizeAndSubscribe(
    ws: WebSocket,
    user: User | undefined,
    runId: string,
  ): Promise<boolean> {
    if (!user?.id || !this.storage) return false;

    // WS connections survive the HTTP upgrade but the ALS context does not
    // propagate through the socket event loop. Wrap storage lookups in
    // runAsSystem so they have context; no project filter is applied in system
    // context, which is correct here — we're looking up a run by ID without
    // knowing its project yet (that's the whole point of the ownership check).
    return runAsSystem("ws-authorize-and-subscribe", async () => {
      const group = await this.storage!.getTaskGroup(runId);
      if (!group) return false; // unknown id → fail closed.
      if (!isVisible(group.createdBy, user)) return false;

      this.subscribe(ws, runId);
      return true;
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
