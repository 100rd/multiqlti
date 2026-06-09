/**
 * Omniscience MCP connection wiring (memory-architecture ADR, Track A).
 *
 * Builds an OmniscienceProvider from the validated app config:
 *   - opens a dedicated MCP Client to Omniscience over stdio OR streamable-http,
 *   - injects the auth token (read from env at call time, never persisted),
 *   - exposes an OmniscienceToolCaller that invokes the `search` tool and
 *     returns its text payload for the provider to validate + map.
 *
 * Auth contract (Omniscience ADR 0004):
 *   - stdio           → token passed via env (OMNISCIENCE_TOKEN by default),
 *   - streamable-http → Authorization: Bearer <token> request header.
 * Token scopes: search, sources:read.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AppConfig } from "../config/schema.js";
import {
  OmniscienceProvider,
  OMNISCIENCE_SEARCH_TOOL,
  type OmniscienceToolCaller,
} from "./omniscience-provider.js";

type OmniscienceConfig = AppConfig["memory"]["retrieval"]["omniscience"];

const CLIENT_NAME = "multiqlti-omniscience-client";
const CLIENT_VERSION = "1.0.0";

/**
 * Read the Omniscience auth token from the configured env var.
 * Throws when the backend is selected but no token is present — fail fast with a
 * clear, secret-free message.
 */
export function resolveOmniscienceToken(cfg: OmniscienceConfig): string {
  const token = process.env[cfg.tokenEnv];
  if (!token) {
    throw new Error(
      `Omniscience backend selected but auth token env "${cfg.tokenEnv}" is not set`,
    );
  }
  return token;
}

/** Build the MCP transport for the configured Omniscience connection + token. */
export function buildOmniscienceTransport(
  cfg: OmniscienceConfig,
  token: string,
): Transport {
  if (cfg.transport === "stdio") {
    if (!cfg.command) {
      throw new Error("Omniscience stdio transport requires `command`");
    }
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: { ...sanitizedEnv(), [cfg.tokenEnv]: token },
    });
  }
  if (!cfg.endpoint) {
    throw new Error("Omniscience streamable-http transport requires `endpoint`");
  }
  return new StreamableHTTPClientTransport(new URL(cfg.endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/** process.env with undefined values dropped, typed for the stdio transport. */
function sanitizedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Wrap an MCP Client into the narrow OmniscienceToolCaller seam.
 * Extracts the text payload from the tool result, mirroring McpClientManager.
 */
export function makeToolCaller(client: Client): OmniscienceToolCaller {
  return async (toolName, args) => {
    const result = await client.callTool({ name: toolName, arguments: args });
    return extractText(result);
  };
}

/** A connected Omniscience provider plus a disposer to close the transport. */
export interface OmniscienceConnection {
  provider: OmniscienceProvider;
  close: () => Promise<void>;
}

/**
 * Connect to Omniscience and return a ready OmniscienceProvider.
 * Caller owns the lifecycle and must invoke `close()` on shutdown.
 */
export async function connectOmniscience(
  cfg: OmniscienceConfig,
): Promise<OmniscienceConnection> {
  const token = resolveOmniscienceToken(cfg);
  const transport = buildOmniscienceTransport(cfg, token);
  const client = new Client(
    { name: CLIENT_NAME, version: CLIENT_VERSION },
    { capabilities: {} },
  );
  await client.connect(transport);

  const provider = new OmniscienceProvider(makeToolCaller(client), {
    retrievalStrategy: cfg.retrievalStrategy,
  });

  return {
    provider,
    close: async () => {
      await client.close();
    },
  };
}

/** Whether the Omniscience backend is selected in config. */
export function isOmniscienceSelected(config: AppConfig): boolean {
  return config.memory.retrieval.backend === "omniscience";
}

/** Tool name used by the provider — re-exported for connection-level config UIs. */
export const OMNISCIENCE_TOOL_NAME = OMNISCIENCE_SEARCH_TOOL;

// ─── Internal ────────────────────────────────────────────────────────────────────

interface TextBlock {
  type: "text";
  text: string;
}

/** Extract concatenated text from an MCP tool result content array. */
function extractText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    return "";
  }
  const content = (result as { content: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n");
}

function isTextBlock(block: unknown): block is TextBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}
