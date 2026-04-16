/**
 * Cross-Instance Delegation Service (issue #233)
 *
 * Allows a pipeline stage to be executed on a remote peer instance.
 * Peers with GPU for inference, or peers with specific API/DB access,
 * can receive delegated stages over the federation transport.
 */
import crypto from "crypto";
import type { FederationManager } from "./index.js";
import type { FederationMessage, PeerInfo } from "./types.js";
import type {
  CrossDelegationPolicy,
  CrossDelegationRequest,
  CrossDelegationResult,
  PipelineStageConfig,
} from "@shared/types";

// ─── Error Types ─────────────────────────────────────────────────────────────

export class DelegationPolicyError extends Error {
  constructor(reason: string) {
    super(`Delegation denied: ${reason}`);
    this.name = "DelegationPolicyError";
  }
}

export class DelegationConcurrencyError extends Error {
  constructor(max: number) {
    super(`Delegation rejected: max concurrent limit (${max}) reached`);
    this.name = "DelegationConcurrencyError";
  }
}

export class CrossDelegationTimeoutError extends Error {
  constructor(delegationId: string, ms: number) {
    super(`Cross-instance delegation ${delegationId} timed out after ${ms}ms`);
    this.name = "CrossDelegationTimeoutError";
  }
}

// ─── Pending Delegation Tracker ──────────────────────────────────────────────

interface PendingDelegation {
  delegationId: string;
  runId: string;
  stageIndex: number;
  targetPeerId: string;
  createdAt: number;
  timeoutMs: number;
  resolve: (result: CrossDelegationResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Stage Executor Callback ─────────────────────────────────────────────────

/** Callback that the host provides to actually execute a stage locally. */
export type LocalStageExecutor = (
  runId: string,
  stageIndex: number,
  stage: PipelineStageConfig,
  input: string,
  variables: Record<string, string>,
) => Promise<{ output: string; tokensUsed: number; executionMs: number }>;

// ─── Service ─────────────────────────────────────────────────────────────────

export class CrossInstanceDelegationService {
  private pending = new Map<string, PendingDelegation>();
  private policy: CrossDelegationPolicy;
  private instanceId: string;
  private localExecutor: LocalStageExecutor | null = null;

  constructor(
    private federation: FederationManager,
    policy: CrossDelegationPolicy,
    instanceId: string,
  ) {
    this.policy = policy;
    this.instanceId = instanceId;
    this.registerHandlers();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Set the local executor used when this instance receives a delegation. */
  setLocalExecutor(executor: LocalStageExecutor): void {
    this.localExecutor = executor;
  }

  /** Update the policy at runtime (e.g. from admin API). */
  updatePolicy(policy: CrossDelegationPolicy): void {
    this.policy = { ...policy };
  }

  /** Get the current delegation policy. */
  getPolicy(): CrossDelegationPolicy {
    return { ...this.policy };
  }

  /**
   * Delegate a stage to a remote peer.
   * Returns a delegation ID that can be used to track or cancel.
   */
  delegateStage(
    runId: string,
    stageIndex: number,
    targetPeerId: string,
    stage: PipelineStageConfig,
    input: string,
    variables: Record<string, string>,
  ): string {
    this.assertEnabled();
    this.assertPeerAllowed(targetPeerId);
    this.assertStageAllowed(stage.teamId);
    this.assertConcurrencyLimit();

    const delegationId = crypto.randomUUID();
    const request: CrossDelegationRequest = {
      id: delegationId,
      runId,
      stageIndex,
      stage,
      input,
      variables,
      fromInstanceId: this.instanceId,
    };

    this.federation.send("stage:delegate", request, targetPeerId);
    return delegationId;
  }

  /**
   * Delegate and wait for the result.
   * Combines delegateStage + waitForResult in one call.
   */
  async delegateAndWait(
    runId: string,
    stageIndex: number,
    targetPeerId: string,
    stage: PipelineStageConfig,
    input: string,
    variables: Record<string, string>,
    timeoutMs?: number,
  ): Promise<CrossDelegationResult> {
    const id = this.delegateStage(
      runId, stageIndex, targetPeerId, stage, input, variables,
    );
    return this.waitForResult(id, timeoutMs);
  }

  /**
   * Wait for a delegation result.
   * Resolves when the peer responds, or rejects on timeout.
   */
  waitForResult(
    delegationId: string,
    timeoutMs?: number,
  ): Promise<CrossDelegationResult> {
    const effectiveTimeout = timeoutMs ?? this.policy.timeoutSeconds * 1000;

    return new Promise<CrossDelegationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resolvePending(delegationId, {
          delegationId,
          status: "timeout",
          output: "",
          tokensUsed: 0,
          executionMs: effectiveTimeout,
          error: `Timed out after ${effectiveTimeout}ms`,
        });
      }, effectiveTimeout);

      const entry: PendingDelegation = {
        delegationId,
        runId: "",
        stageIndex: -1,
        targetPeerId: "",
        createdAt: Date.now(),
        timeoutMs: effectiveTimeout,
        resolve,
        reject,
        timer,
      };
      this.pending.set(delegationId, entry);
    });
  }

  /** Check whether a delegation to the given peer/stage is allowed. */
  canDelegate(stageId: string, peerId: string): boolean {
    if (!this.policy.enabled) return false;
    if (!this.isPeerAllowed(peerId)) return false;
    if (!this.isStageAllowed(stageId)) return false;
    if (this.pending.size >= this.policy.maxConcurrent) return false;
    return this.isPeerConnected(peerId);
  }

  /** List all in-flight delegations. */
  getActiveDelegations(): Array<{
    delegationId: string;
    targetPeerId: string;
    createdAt: number;
    timeoutMs: number;
  }> {
    return Array.from(this.pending.values()).map((p) => ({
      delegationId: p.delegationId,
      targetPeerId: p.targetPeerId,
      createdAt: p.createdAt,
      timeoutMs: p.timeoutMs,
    }));
  }

  /** Cancel a pending delegation. */
  cancelDelegation(delegationId: string): boolean {
    const entry = this.pending.get(delegationId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(delegationId);
    entry.reject(new Error(`Delegation ${delegationId} cancelled`));
    return true;
  }

  /** Clean up all pending delegations (for shutdown). */
  dispose(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Service shutting down"));
      this.pending.delete(id);
    }
  }

  // ── Private: Message Handlers ────────────────────────────────────────────

  private registerHandlers(): void {
    this.federation.on("stage:delegate", (msg, peer) => {
      void this.handleDelegateRequest(msg, peer);
    });

    this.federation.on("stage:delegate:result", (msg) => {
      this.handleDelegateResult(msg);
    });
  }

  /** Handle an incoming delegation request from a remote peer. */
  private async handleDelegateRequest(
    msg: FederationMessage,
    peer: PeerInfo,
  ): Promise<void> {
    const request = msg.payload as CrossDelegationRequest;
    const startMs = Date.now();

    if (!this.policy.enabled) {
      this.sendResult(peer.instanceId, request.id, {
        delegationId: request.id,
        status: "failed",
        output: "",
        tokensUsed: 0,
        executionMs: 0,
        error: "Delegation is disabled on this instance",
      });
      return;
    }

    if (!this.localExecutor) {
      this.sendResult(peer.instanceId, request.id, {
        delegationId: request.id,
        status: "failed",
        output: "",
        tokensUsed: 0,
        executionMs: 0,
        error: "No local executor configured",
      });
      return;
    }

    try {
      const result = await this.localExecutor(
        request.runId,
        request.stageIndex,
        request.stage,
        request.input,
        request.variables,
      );

      this.sendResult(peer.instanceId, request.id, {
        delegationId: request.id,
        status: "completed",
        output: result.output,
        tokensUsed: result.tokensUsed,
        executionMs: result.executionMs,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.sendResult(peer.instanceId, request.id, {
        delegationId: request.id,
        status: "failed",
        output: "",
        tokensUsed: 0,
        executionMs: Date.now() - startMs,
        error: errorMsg,
      });
    }
  }

  /** Handle result message from a peer that executed our delegation. */
  private handleDelegateResult(msg: FederationMessage): void {
    const result = msg.payload as CrossDelegationResult;
    this.resolvePending(result.delegationId, result);
  }

  /** Send a result message back to the requesting peer. */
  private sendResult(
    toPeerId: string,
    delegationId: string,
    result: CrossDelegationResult,
  ): void {
    this.federation.send("stage:delegate:result", result, toPeerId);
  }

  /** Resolve a pending delegation and clean up timer. */
  private resolvePending(
    delegationId: string,
    result: CrossDelegationResult,
  ): void {
    const entry = this.pending.get(delegationId);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(delegationId);
    entry.resolve(result);
  }

  // ── Private: Policy Checks ───────────────────────────────────────────────

  private assertEnabled(): void {
    if (!this.policy.enabled) {
      throw new DelegationPolicyError("delegation is disabled");
    }
  }

  private assertPeerAllowed(peerId: string): void {
    if (!this.isPeerAllowed(peerId)) {
      throw new DelegationPolicyError(`peer "${peerId}" is not allowed`);
    }
  }

  private assertStageAllowed(stageId: string): void {
    if (!this.isStageAllowed(stageId)) {
      throw new DelegationPolicyError(`stage "${stageId}" is not allowed`);
    }
  }

  private assertConcurrencyLimit(): void {
    if (this.pending.size >= this.policy.maxConcurrent) {
      throw new DelegationConcurrencyError(this.policy.maxConcurrent);
    }
  }

  private isPeerAllowed(peerId: string): boolean {
    if (this.policy.allowedPeers === null) return true;
    return this.policy.allowedPeers.includes(peerId);
  }

  private isStageAllowed(stageId: string): boolean {
    if (this.policy.allowedStages === null) return true;
    return this.policy.allowedStages.includes(stageId);
  }

  private isPeerConnected(peerId: string): boolean {
    return this.federation
      .getPeers()
      .some((p) => p.instanceId === peerId && p.status === "connected");
  }
}
