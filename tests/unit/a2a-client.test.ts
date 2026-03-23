import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { A2AClient } from "../../server/remote-agents/a2a-client.js";
import type { AgentCard, A2AMessage } from "@shared/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jsonRpcOk(result: unknown, id = "test-id") {
  return { jsonrpc: "2.0" as const, id, result };
}

function jsonRpcError(code: number, message: string, id = "test-id") {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function mockFetchResponse(body: unknown, status = 200, statusText = "OK") {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      statusText,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const AGENT_CARD: AgentCard = {
  name: "test-agent",
  version: "1.0.0",
  url: "https://agent.example.com",
  skills: [{ id: "code", name: "Code Generation" }],
  capabilities: { streaming: true },
};

const TEST_MESSAGE: A2AMessage = {
  role: "user",
  parts: [{ type: "text", text: "Hello agent" }],
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("A2AClient", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── discover ─────────────────────────────────────────────────────────────

  describe("discover()", () => {
    it("returns parsed AgentCard on success", async () => {
      fetchSpy.mockReturnValueOnce(mockFetchResponse(AGENT_CARD));
      const client = new A2AClient({ endpoint: "https://agent.example.com" });

      const card = await client.discover();

      expect(card).toEqual(AGENT_CARD);
      expect(fetchSpy).toHaveBeenCalledOnce();

      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://agent.example.com/.well-known/agent.json");
      expect(opts.method).toBe("GET");
    });

    it("throws on non-200 response", async () => {
      fetchSpy.mockReturnValueOnce(
        Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
      );
      const client = new A2AClient({ endpoint: "https://agent.example.com" });

      await expect(client.discover()).rejects.toThrow(
        "A2A discovery failed: HTTP 404 Not Found",
      );
    });

    it("strips trailing slash from endpoint", async () => {
      fetchSpy.mockReturnValueOnce(mockFetchResponse(AGENT_CARD));
      const client = new A2AClient({ endpoint: "https://agent.example.com/" });

      await client.discover();

      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toBe("https://agent.example.com/.well-known/agent.json");
    });
  });

  // ── sendTask ─────────────────────────────────────────────────────────────

  describe("sendTask()", () => {
    it("sends correct JSON-RPC request and returns response", async () => {
      const taskResponse = { id: "task-1", status: "completed", output: { role: "agent", parts: [{ type: "text", text: "Done" }] } };
      fetchSpy.mockReturnValueOnce(mockFetchResponse(jsonRpcOk(taskResponse)));

      const client = new A2AClient({ endpoint: "https://agent.example.com" });
      const result = await client.sendTask({ message: TEST_MESSAGE, skill: "code" });

      expect(result).toEqual(taskResponse);

      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://agent.example.com/a2a");
      expect(opts.method).toBe("POST");

      const body = JSON.parse(opts.body as string);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.method).toBe("message/send");
      expect(body.params.message).toEqual(TEST_MESSAGE);
      expect(body.params.skill).toBe("code");
      expect(body.id).toBeTruthy();
    });

    it("passes taskId as 'id' in params when provided", async () => {
      fetchSpy.mockReturnValueOnce(
        mockFetchResponse(jsonRpcOk({ id: "my-task", status: "submitted" })),
      );

      const client = new A2AClient({ endpoint: "https://agent.example.com" });
      await client.sendTask({ message: TEST_MESSAGE, taskId: "my-task" });

      const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.params.id).toBe("my-task");
    });

    it("throws on RPC error response", async () => {
      fetchSpy.mockReturnValueOnce(
        mockFetchResponse(jsonRpcError(-32600, "Invalid request")),
      );

      const client = new A2AClient({ endpoint: "https://agent.example.com" });

      await expect(
        client.sendTask({ message: TEST_MESSAGE }),
      ).rejects.toThrow("A2A sendTask RPC error (-32600): Invalid request");
    });
  });

  // ── getTask ──────────────────────────────────────────────────────────────

  describe("getTask()", () => {
    it("sends tasks/get method with correct id", async () => {
      const taskResponse = { id: "task-42", status: "working" };
      fetchSpy.mockReturnValueOnce(mockFetchResponse(jsonRpcOk(taskResponse)));

      const client = new A2AClient({ endpoint: "https://agent.example.com" });
      const result = await client.getTask("task-42");

      expect(result).toEqual(taskResponse);

      const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.method).toBe("tasks/get");
      expect(body.params.id).toBe("task-42");
    });

    it("throws on RPC error", async () => {
      fetchSpy.mockReturnValueOnce(
        mockFetchResponse(jsonRpcError(-32001, "Task not found")),
      );

      const client = new A2AClient({ endpoint: "https://agent.example.com" });

      await expect(client.getTask("missing")).rejects.toThrow(
        "A2A getTask RPC error (-32001): Task not found",
      );
    });
  });

  // ── cancelTask ───────────────────────────────────────────────────────────

  describe("cancelTask()", () => {
    it("sends tasks/cancel method with correct id", async () => {
      const taskResponse = { id: "task-99", status: "cancelled" };
      fetchSpy.mockReturnValueOnce(mockFetchResponse(jsonRpcOk(taskResponse)));

      const client = new A2AClient({ endpoint: "https://agent.example.com" });
      const result = await client.cancelTask("task-99");

      expect(result).toEqual(taskResponse);

      const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.method).toBe("tasks/cancel");
      expect(body.params.id).toBe("task-99");
    });
  });

  // ── streamTask ───────────────────────────────────────────────────────────

  describe("streamTask()", () => {
    it("parses SSE events from stream", async () => {
      const events = [
        { type: "status", taskId: "t1", status: "working" },
        { type: "artifact", taskId: "t1", artifact: { type: "text", text: "result" } },
        { type: "status", taskId: "t1", status: "completed" },
      ];

      const ssePayload = events
        .map((e) => `data: ${JSON.stringify(e)}`)
        .join("\n\n");

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ssePayload + "\n\n"));
          controller.close();
        },
      });

      fetchSpy.mockReturnValueOnce(
        Promise.resolve(new Response(stream, { status: 200 })),
      );

      const client = new A2AClient({ endpoint: "https://agent.example.com" });
      const received: unknown[] = [];

      for await (const event of client.streamTask({ message: TEST_MESSAGE })) {
        received.push(event);
      }

      expect(received).toHaveLength(3);
      expect(received[0]).toEqual(events[0]);
      expect(received[1]).toEqual(events[1]);
      expect(received[2]).toEqual(events[2]);

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect((opts.headers as Record<string, string>)["Accept"]).toBe(
        "text/event-stream",
      );
    });

    it("skips comment lines and empty lines in SSE", async () => {
      const ssePayload = `: this is a comment\n\ndata: ${JSON.stringify({ type: "status", taskId: "t1", status: "working" })}\n\n`;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ssePayload));
          controller.close();
        },
      });

      fetchSpy.mockReturnValueOnce(
        Promise.resolve(new Response(stream, { status: 200 })),
      );

      const client = new A2AClient({ endpoint: "https://agent.example.com" });
      const received: unknown[] = [];

      for await (const event of client.streamTask({ message: TEST_MESSAGE })) {
        received.push(event);
      }

      expect(received).toHaveLength(1);
    });
  });

  // ── Auth header ──────────────────────────────────────────────────────────

  describe("auth headers", () => {
    it("includes Authorization header when token provided", async () => {
      fetchSpy.mockReturnValueOnce(mockFetchResponse(AGENT_CARD));

      const client = new A2AClient({
        endpoint: "https://agent.example.com",
        authToken: "my-secret-token",
      });
      await client.discover();

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer my-secret-token");
    });

    it("omits Authorization header when no token", async () => {
      fetchSpy.mockReturnValueOnce(mockFetchResponse(AGENT_CARD));

      const client = new A2AClient({ endpoint: "https://agent.example.com" });
      await client.discover();

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });
  });

  // ── Timeout ──────────────────────────────────────────────────────────────

  describe("timeout", () => {
    it("aborts request when timeout expires", async () => {
      fetchSpy.mockImplementation(
        (_url: string, opts: RequestInit) =>
          new Promise((_resolve, reject) => {
            opts.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      );

      const client = new A2AClient({
        endpoint: "https://agent.example.com",
        timeoutMs: 50,
      });

      await expect(client.discover()).rejects.toThrow("aborted");
    });
  });
});
