import type { IStorage } from "../storage";
import type { TeamRegistry } from "../teams/registry";
import type { WsManager } from "../ws/manager";
import type { Gateway } from "../gateway/index";
import type {
  DelegationRequest,
  DelegationResult,
  DelegationStatus,
  TeamId,
  StageContext,
} from "@shared/types";
import { MAX_DELEGATION_DEPTH } from "@shared/types";
import type { InsertDelegationRequest, DelegationRequestRow } from "@shared/schema";

// ─── Error Types ──────────────────────────────────────────────────────────────

export class DelegationDepthError extends Error {
  constructor(depth: number) {
    super(
      `Delegation rejected: max depth ${MAX_DELEGATION_DEPTH} exceeded (current depth: ${depth})`,
    );
    this.name = "DelegationDepthError";
  }
}

export class DelegationCircularError extends Error {
  constructor(chain: TeamId[]) {
    super(`Circular delegation detected: ${chain.join(" \u2192 ")}`);
    this.name = "DelegationCircularError";
  }
}

export class DelegationTimeoutError extends Error {
  constructor(ms: number) {
    super(`Delegation timed out after ${ms}ms`);
    this.name = "DelegationTimeoutError";
  }
}

// ─── DelegationService ────────────────────────────────────────────────────────

export class DelegationService {
  constructor(
    private storage: IStorage,
    private teamRegistry: TeamRegistry,
    private wsManager: WsManager,
    private gateway: Gateway,
  ) {}

  /**
   * Blocking delegation: awaits result. Enforces timeout via Promise.race().
   */
  async delegate(
    runId: string,
    request: DelegationRequest,
    callChain: TeamId[],
  ): Promise<DelegationResult> {
    this.validateDepth(callChain);
    this.validateCircular(callChain, request.toStage);

    const recordId = await this.initRecord(runId, request, callChain.length);

    return Promise.race([
      this.executeDelegate(runId, request, callChain, recordId),
      this.makeTimeoutPromise(request.timeout, recordId, runId, request),
    ]);
  }

  /**
   * Fire-and-forget delegation: launches without awaiting.
   */
  delegateAsync(
    runId: string,
    request: DelegationRequest,
    callChain: TeamId[],
  ): void {
    this.validateDepth(callChain);
    this.validateCircular(callChain, request.toStage);

    void this.initRecord(runId, request, callChain.length).then((recordId) =>
      this.executeDelegate(runId, request, callChain, recordId).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[DelegationService] async delegation failed: ${msg}`);
      }),
    );
  }

  /**
   * Core execution: runs the target team and persists results.
   */
  private async executeDelegate(
    runId: string,
    request: DelegationRequest,
    callChain: TeamId[],
    recordId: string,
  ): Promise<DelegationResult> {
    const startedAt = Date.now();

    try {
      const team = this.teamRegistry.getTeam(request.toStage);
      const newDepth = callChain.length + 1;

      const subContext: StageContext = {
        runId,
        stageIndex: -1,
        previousOutputs: [],
        fullContext: [],
        delegate:
          newDepth < MAX_DELEGATION_DEPTH
            ? (req) =>
                this.delegate(runId, req, [...callChain, request.toStage])
            : undefined,
      };

      const teamResult = await team.execute(
        { taskDescription: request.task, ...request.context },
        subContext,
      );

      const durationMs = Date.now() - startedAt;
      const result: DelegationResult = {
        output: teamResult.output,
        raw: teamResult.raw,
        tokensUsed: teamResult.tokensUsed,
        durationMs,
      };

      await this.storage.updateDelegationRequest(recordId, {
        status: "completed" as DelegationStatus,
        result: result as unknown as Record<string, unknown>,
        completedAt: new Date(),
      });

      this.broadcast(runId, "delegation:completed", {
        delegationId: recordId,
        fromStage: request.fromStage,
        toStage: request.toStage,
        tokensUsed: result.tokensUsed,
        durationMs: result.durationMs,
      });

      return result;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      await this.storage.updateDelegationRequest(recordId, {
        status: "failed" as DelegationStatus,
        errorMessage,
        completedAt: new Date(),
      });

      this.broadcast(runId, "delegation:failed", {
        delegationId: recordId,
        fromStage: request.fromStage,
        toStage: request.toStage,
        error: errorMessage,
        status: "failed",
      });

      throw err;
    }
  }

  /**
   * Creates a DB record and broadcasts delegation:requested.
   * Returns the record ID.
   */
  private async initRecord(
    runId: string,
    request: DelegationRequest,
    depth: number,
  ): Promise<string> {
    const data: InsertDelegationRequest = {
      runId,
      fromStage: request.fromStage,
      toStage: request.toStage,
      task: request.task,
      context: request.context,
      priority: request.priority,
      timeout: request.timeout,
      depth,
      status: "running",
      startedAt: new Date(),
    };

    const row: DelegationRequestRow = await this.storage.createDelegationRequest(data);

    this.broadcast(runId, "delegation:requested", {
      delegationId: row.id,
      fromStage: request.fromStage,
      toStage: request.toStage,
      task: request.task,
      priority: request.priority,
      depth,
    });

    return row.id;
  }

  /**
   * Returns a promise that rejects after ms milliseconds.
   */
  private makeTimeoutPromise(
    ms: number,
    recordId: string,
    runId: string,
    request: DelegationRequest,
  ): Promise<never> {
    return new Promise<never>((_, reject) => {
      setTimeout(async () => {
        await this.storage.updateDelegationRequest(recordId, {
          status: "timeout" as DelegationStatus,
          completedAt: new Date(),
        });

        this.broadcast(runId, "delegation:failed", {
          delegationId: recordId,
          fromStage: request.fromStage,
          toStage: request.toStage,
          error: "timeout",
          status: "timeout",
        });

        reject(new DelegationTimeoutError(ms));
      }, ms);
    });
  }

  /**
   * Throws DelegationDepthError if depth limit would be exceeded.
   */
  private validateDepth(callChain: TeamId[]): void {
    if (callChain.length >= MAX_DELEGATION_DEPTH) {
      throw new DelegationDepthError(callChain.length);
    }
  }

  /**
   * Throws DelegationCircularError if toStage is already in the call chain.
   */
  private validateCircular(callChain: TeamId[], toStage: TeamId): void {
    if (callChain.includes(toStage)) {
      throw new DelegationCircularError([...callChain, toStage]);
    }
  }

  private broadcast(
    runId: string,
    type: "delegation:requested" | "delegation:completed" | "delegation:failed",
    payload: Record<string, unknown>,
  ): void {
    this.wsManager.broadcastToRun(runId, {
      type,
      runId,
      payload,
      timestamp: new Date().toISOString(),
    });
  }
}
