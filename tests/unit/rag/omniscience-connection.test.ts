/**
 * Tests for the Omniscience MCP connection wiring (memory-architecture ADR,
 * Track A).
 *
 * Covers the pure, transport-independent seams:
 *   - token resolution from the configured env var (never hardcoded),
 *   - transport selection (stdio vs streamable-http) + required-field errors,
 *   - the flag helper,
 *   - the tool-caller text extraction over a fake MCP client.
 */
import { describe, it, expect, afterEach } from "vitest";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  resolveOmniscienceToken,
  buildOmniscienceTransport,
  makeToolCaller,
  isOmniscienceSelected,
} from "../../../server/memory/omniscience-connection";
import { ConfigSchema, type AppConfig } from "../../../server/config/schema";

type OmniscienceConfig = AppConfig["memory"]["retrieval"]["omniscience"];

function omniscienceConfig(overrides: Partial<OmniscienceConfig> = {}): OmniscienceConfig {
  const base = ConfigSchema.parse({}).memory.retrieval.omniscience;
  return { ...base, ...overrides };
}

const SAVED_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

describe("resolveOmniscienceToken", () => {
  it("reads the token from the configured env var", () => {
    process.env.OMNISCIENCE_TOKEN = "test-token-value";
    expect(resolveOmniscienceToken(omniscienceConfig())).toBe("test-token-value");
  });

  it("honors a custom tokenEnv name", () => {
    delete process.env.OMNISCIENCE_TOKEN;
    process.env.CUSTOM_OMNI_TOKEN = "custom-token";
    expect(
      resolveOmniscienceToken(omniscienceConfig({ tokenEnv: "CUSTOM_OMNI_TOKEN" })),
    ).toBe("custom-token");
  });

  it("throws (secret-free) when the token env is unset", () => {
    delete process.env.OMNISCIENCE_TOKEN;
    expect(() => resolveOmniscienceToken(omniscienceConfig())).toThrow(
      /OMNISCIENCE_TOKEN.*not set/,
    );
  });
});

describe("buildOmniscienceTransport", () => {
  it("builds a stdio transport when transport=stdio and command is set", () => {
    const transport = buildOmniscienceTransport(
      omniscienceConfig({ transport: "stdio", command: "omniscience-mcp", args: ["--serve"] }),
      "tok",
    );
    expect(transport).toBeInstanceOf(StdioClientTransport);
  });

  it("throws when stdio transport lacks a command", () => {
    expect(() =>
      buildOmniscienceTransport(omniscienceConfig({ transport: "stdio" }), "tok"),
    ).toThrow(/requires `command`/);
  });

  it("builds a streamable-http transport with the endpoint", () => {
    const transport = buildOmniscienceTransport(
      omniscienceConfig({
        transport: "streamable-http",
        endpoint: "https://omni.example.com/mcp",
      }),
      "tok",
    );
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it("throws when streamable-http transport lacks an endpoint", () => {
    expect(() =>
      buildOmniscienceTransport(omniscienceConfig({ transport: "streamable-http" }), "tok"),
    ).toThrow(/requires `endpoint`/);
  });
});

describe("makeToolCaller", () => {
  it("extracts concatenated text from the MCP tool result", async () => {
    const fakeClient = {
      callTool: async () => ({
        content: [
          { type: "text", text: "line one" },
          { type: "image", data: "ignored" },
          { type: "text", text: "line two" },
        ],
      }),
    } as unknown as Client;

    const caller = makeToolCaller(fakeClient);
    const out = await caller("search", { query: "x" });

    expect(out).toBe("line one\nline two");
  });

  it("returns an empty string when the result has no content array", async () => {
    const fakeClient = { callTool: async () => ({}) } as unknown as Client;
    const caller = makeToolCaller(fakeClient);
    expect(await caller("search", {})).toBe("");
  });
});

describe("isOmniscienceSelected", () => {
  it("is false by default (local backend)", () => {
    expect(isOmniscienceSelected(ConfigSchema.parse({}))).toBe(false);
  });

  it("is true when the backend flag selects omniscience", () => {
    const config = ConfigSchema.parse({
      memory: { retrieval: { backend: "omniscience" } },
    });
    expect(isOmniscienceSelected(config)).toBe(true);
  });
});
