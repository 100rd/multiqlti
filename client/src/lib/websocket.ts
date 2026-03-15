import type { WsEvent, WsEventType } from "@shared/types";

type EventHandler = (event: WsEvent) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private listeners: Map<WsEventType | "*", Set<EventHandler>> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribedRuns: Set<string> = new Set();

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = localStorage.getItem("auth_token");
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    const url = `${protocol}//${window.location.host}/ws${tokenParam}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      // Re-subscribe to any runs we were following
      for (const runId of this.subscribedRuns) {
        this.send({ type: "subscribe", runId });
      }
    };

    this.ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data as string) as WsEvent;
        this.emit(event);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  subscribe(runId: string): void {
    this.subscribedRuns.add(runId);
    this.send({ type: "subscribe", runId });
  }

  unsubscribe(runId: string): void {
    this.subscribedRuns.delete(runId);
    this.send({ type: "unsubscribe", runId });
  }

  on(eventType: WsEventType, handler: EventHandler): () => void {
    let handlers = this.listeners.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(eventType, handlers);
    }
    handlers.add(handler);
    return () => handlers!.delete(handler);
  }

  onAny(handler: EventHandler): () => void {
    let handlers = this.listeners.get("*");
    if (!handlers) {
      handlers = new Set();
      this.listeners.set("*", handlers);
    }
    handlers.add(handler);
    return () => handlers!.delete(handler);
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private emit(event: WsEvent): void {
    const typeHandlers = this.listeners.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) handler(event);
    }
    const anyHandlers = this.listeners.get("*");
    if (anyHandlers) {
      for (const handler of anyHandlers) handler(event);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}

export const wsClient = new WsClient();
