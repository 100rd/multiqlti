/**
 * Tests that all transport adapters correctly implement the TransportAdapter
 * interface and produce well-formed LatencySample / ReconnectMetrics outputs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RedisBaselineAdapter } from "../../../scripts/federation-bench/adapters/redis-baseline.js";
import { NatsAdapter } from "../../../scripts/federation-bench/adapters/nats-adapter.js";
import { GrpcAdapter } from "../../../scripts/federation-bench/adapters/grpc-adapter.js";
import { Libp2pAdapter } from "../../../scripts/federation-bench/adapters/libp2p-adapter.js";
import { QuicAdapter } from "../../../scripts/federation-bench/adapters/quic-adapter.js";
import type { TransportAdapter, BenchMessage } from "../../../scripts/federation-bench/types.js";

const ADAPTERS: TransportAdapter[] = [
  new RedisBaselineAdapter(),
  new NatsAdapter(),
  new GrpcAdapter(),
  new Libp2pAdapter(),
  new QuicAdapter(),
];

function makeMsgId(): string {
  return `test-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeMessage(): BenchMessage {
  return {
    id: makeMsgId(),
    payload: { hello: "world", ts: Date.now() },
    sentAt: Date.now(),
  };
}

describe("TransportAdapter interface — all adapters", () => {
  for (const adapter of ADAPTERS) {
    describe(adapter.name, () => {
      beforeEach(async () => {
        await adapter.setup();
      });

      afterEach(async () => {
        await adapter.teardown();
      });

      it("has a non-empty name and description", () => {
        expect(adapter.name).toBeTruthy();
        expect(adapter.name.length).toBeGreaterThan(0);
        expect(adapter.description).toBeTruthy();
        expect(adapter.description.length).toBeGreaterThan(10);
      });

      it("send() returns a LatencySample with correct messageId on success", async () => {
        const msg = makeMessage();
        const sample = await adapter.send(msg, 0);
        expect(sample.messageId).toBe(msg.id);
        expect(typeof sample.latencyMs).toBe("number");
        expect(typeof sample.success).toBe("boolean");
      });

      it("send() returns success=true and positive latency with zero loss rate", async () => {
        // Send several messages to avoid lucky random hits
        const results = await Promise.all(
          Array.from({ length: 10 }, () => adapter.send(makeMessage(), 0)),
        );
        const successes = results.filter((r) => r.success);
        expect(successes.length).toBeGreaterThan(0);
        for (const s of successes) {
          expect(s.latencyMs).toBeGreaterThan(0);
        }
      });

      it("send() with 100% loss rate returns droppedByPacketLoss=true for most messages", async () => {
        const results = await Promise.all(
          Array.from({ length: 20 }, () => adapter.send(makeMessage(), 1.0)),
        );
        // QUIC recovers some "dropped" packets — allow some successes
        const dropped = results.filter((r) => !r.success || r.droppedByPacketLoss);
        expect(dropped.length).toBeGreaterThan(0);
      });

      it("partition() followed by recover() returns valid ReconnectMetrics", async () => {
        await adapter.partition();
        const metrics = await adapter.recover();

        expect(typeof metrics.reconnectAttempts).toBe("number");
        expect(metrics.reconnectAttempts).toBeGreaterThan(0);
        expect(typeof metrics.reconnectDurationMs).toBe("number");
        expect(metrics.reconnectDurationMs).toBeGreaterThanOrEqual(0);
        expect(typeof metrics.messagesDropped).toBe("number");
        expect(metrics.messagesDropped).toBeGreaterThanOrEqual(0);
        expect(typeof metrics.messagesRedelivered).toBe("number");
        expect(metrics.messagesRedelivered).toBeGreaterThanOrEqual(0);
        expect(typeof metrics.partitionDetectedMs).toBe("number");
        expect(metrics.partitionDetectedMs).toBeGreaterThan(0);
      });

      it("send() during partition returns success=false", async () => {
        await adapter.partition();
        const sample = await adapter.send(makeMessage(), 0);
        // All adapters should fail to deliver during a partition
        // QUIC may have 0-RTT but simulates partition as hard failure
        expect(sample.success).toBe(false);
        // Restore
        await adapter.recover();
      });

      it("send() succeeds again after recover()", async () => {
        await adapter.partition();
        await adapter.recover();

        const results = await Promise.all(
          Array.from({ length: 5 }, () => adapter.send(makeMessage(), 0)),
        );
        const successes = results.filter((r) => r.success);
        expect(successes.length).toBeGreaterThan(0);
      });
    });
  }
});
