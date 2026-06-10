/**
 * M-WS-1 — the StrategyExecutor debate broadcasts must scrub secrets from the
 * model `content`/`verdict` BEFORE they cross the WS trust boundary (the live
 * stream is pre-persistence). The persisted DebateDetails keeps raw content.
 *
 * Deterministic: a scripted gateway double + a spy WsManager + a secret planted
 * in process.env. No CLI / network. Invoked by vitest unit project.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrategyExecutor } from "../../server/services/strategy-executor.js";
import type {
  DebateStrategy,
  DebateDetails,
  GatewayRequest,
  GatewayResponse,
} from "../../shared/types.js";
import type { Gateway } from "../../server/gateway/index.js";
import type { WsManager } from "../../server/ws/manager.js";

const SECRET = "super-secret-token-value-123456";

/** Gateway double: every turn echoes a model response that leaks the secret. */
function leakyGateway(): Gateway {
  return {
    complete: vi.fn(
      async (_req: GatewayRequest): Promise<GatewayResponse> => ({
        content: `model output containing ${SECRET} inline`,
        tokensUsed: 1,
        modelSlug: "m",
        finishReason: "stop",
      }),
    ),
    resolveProvider: vi.fn(async (slug: string) =>
      slug === "gemini-flash" ? "antigravity" : "anthropic",
    ),
  } as unknown as Gateway;
}

describe("StrategyExecutor debate WS broadcasts — secret scrubbing (M-WS-1)", () => {
  beforeEach(() => {
    process.env.MWS1_TEST_API_KEY = SECRET; // *_API_KEY → recognized secret name
  });
  afterEach(() => {
    delete process.env.MWS1_TEST_API_KEY;
    vi.restoreAllMocks();
  });

  it("scrubs round content and judge verdict in the WS payloads (raw persisted)", async () => {
    const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const wsManager = {
      broadcastToRun: vi.fn(
        (_runId: string, ev: { type: string; payload: Record<string, unknown> }) => {
          broadcasts.push({ type: ev.type, payload: ev.payload });
        },
      ),
    } as unknown as WsManager;

    const executor = new StrategyExecutor(leakyGateway(), wsManager);
    const strategy: DebateStrategy = {
      type: "debate",
      participants: [
        { modelSlug: "claude-opus", role: "proposer" },
        { modelSlug: "gemini-flash", role: "critic" },
      ],
      judge: { modelSlug: "claude-opus" },
      rounds: 1,
    };

    const result = await executor.execute(strategy, [{ role: "user", content: "debate this" }], {
      runId: "run-1",
      stageId: "stage-1",
    });

    const roundEvents = broadcasts.filter((b) => b.type === "strategy:debate:round");
    const judgeEvents = broadcasts.filter((b) => b.type === "strategy:debate:judge");
    expect(roundEvents.length).toBeGreaterThan(0);
    expect(judgeEvents.length).toBe(1);

    // WS payloads must NOT contain the raw secret.
    for (const ev of roundEvents) {
      expect(String(ev.payload.content)).not.toContain(SECRET);
      expect(String(ev.payload.content)).toContain("[REDACTED]");
    }
    expect(String(judgeEvents[0].payload.verdict)).not.toContain(SECRET);
    expect(String(judgeEvents[0].payload.verdict)).toContain("[REDACTED]");

    // The persisted transcript keeps the raw content (scrub happens at persist).
    const details = result.details as DebateDetails;
    expect(details.rounds.some((r) => r.content.includes(SECRET))).toBe(true);
    expect(details.verdict).toContain(SECRET);
  });
});
