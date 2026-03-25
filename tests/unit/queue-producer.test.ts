import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock BullMQ before any imports ───────────────────────────────────────────

const mockAdd = vi.fn();
const mockGetJob = vi.fn();
const mockQueueClose = vi.fn();

vi.mock("bullmq", () => {
  return {
    Queue: class MockQueue {
      add = mockAdd;
      getJob = mockGetJob;
      close = mockQueueClose;
      constructor(public name: string, public opts: unknown) {}
    },
    Worker: class MockWorker {
      close = vi.fn();
      on = vi.fn();
      constructor(
        public name: string,
        public processor: unknown,
        public opts: unknown,
      ) {}
    },
  };
});

vi.mock("ioredis", () => ({
  Redis: class MockRedis {
    quit = vi.fn().mockResolvedValue("OK");
    status = "ready";
    constructor() {}
  },
}));

import { StageQueueProducer, STAGE_QUEUE_NAME } from "../../server/queue/producer";
import { isQueueEnabled } from "../../server/queue/index";
import { getRedisConnection } from "../../server/queue/connection";
import type { StageJobData } from "../../server/queue/producer";

describe("StageQueueProducer", () => {
  let producer: StageQueueProducer;
  const fakeRedis = { status: "ready" } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    producer = new StageQueueProducer(fakeRedis);
  });

  afterEach(async () => {
    await producer.close();
  });

  const sampleJob: StageJobData = {
    runId: "run-abc-123",
    stageIndex: 2,
    stageConfig: { teamId: "code-gen", modelSlug: "gpt-4o" },
    input: "Write a sorting function",
  };

  it("enqueueStage passes correct data and options", async () => {
    mockAdd.mockResolvedValue({ id: "job-001" });

    const jobId = await producer.enqueueStage(sampleJob);

    expect(mockAdd).toHaveBeenCalledWith("execute", sampleJob, {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    });
    expect(jobId).toBe("job-001");
  });

  it("enqueueStage returns the BullMQ job id", async () => {
    mockAdd.mockResolvedValue({ id: "job-xyz" });

    const id = await producer.enqueueStage(sampleJob);
    expect(id).toBe("job-xyz");
  });

  it("getJobStatus returns the state of an existing job", async () => {
    mockGetJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue("completed"),
    });

    const status = await producer.getJobStatus("job-001");
    expect(status).toBe("completed");
    expect(mockGetJob).toHaveBeenCalledWith("job-001");
  });

  it("getJobStatus returns 'unknown' when job does not exist", async () => {
    mockGetJob.mockResolvedValue(null);

    const status = await producer.getJobStatus("nonexistent");
    expect(status).toBe("unknown");
  });

  it("getJobStatus returns 'waiting' for a waiting job", async () => {
    mockGetJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue("waiting"),
    });

    const status = await producer.getJobStatus("job-002");
    expect(status).toBe("waiting");
  });

  it("getJobStatus returns 'active' for an active job", async () => {
    mockGetJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue("active"),
    });

    const status = await producer.getJobStatus("job-003");
    expect(status).toBe("active");
  });

  it("getJobStatus returns 'failed' for a failed job", async () => {
    mockGetJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue("failed"),
    });

    const status = await producer.getJobStatus("job-004");
    expect(status).toBe("failed");
  });

  it("getJobStatus returns 'delayed' for a delayed job", async () => {
    mockGetJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue("delayed"),
    });

    const status = await producer.getJobStatus("job-005");
    expect(status).toBe("delayed");
  });

  it("close shuts down the queue", async () => {
    // close is called in afterEach, but test the assertion explicitly
    await producer.close();
    expect(mockQueueClose).toHaveBeenCalled();
  });
});

describe("isQueueEnabled", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns false when neither env var is set", () => {
    delete process.env.MULTI_FEATURES_WORKER_QUEUE;
    delete process.env.REDIS_URL;
    expect(isQueueEnabled()).toBe(false);
  });

  it("returns false when only REDIS_URL is set", () => {
    delete process.env.MULTI_FEATURES_WORKER_QUEUE;
    process.env.REDIS_URL = "redis://localhost:6379";
    expect(isQueueEnabled()).toBe(false);
  });

  it("returns false when only MULTI_FEATURES_WORKER_QUEUE is set", () => {
    process.env.MULTI_FEATURES_WORKER_QUEUE = "true";
    delete process.env.REDIS_URL;
    expect(isQueueEnabled()).toBe(false);
  });

  it("returns false when MULTI_FEATURES_WORKER_QUEUE is not 'true'", () => {
    process.env.MULTI_FEATURES_WORKER_QUEUE = "false";
    process.env.REDIS_URL = "redis://localhost:6379";
    expect(isQueueEnabled()).toBe(false);
  });

  it("returns true when both vars are correctly set", () => {
    process.env.MULTI_FEATURES_WORKER_QUEUE = "true";
    process.env.REDIS_URL = "redis://localhost:6379";
    expect(isQueueEnabled()).toBe(true);
  });

  it("returns false when MULTI_FEATURES_WORKER_QUEUE is '1' (strict check)", () => {
    process.env.MULTI_FEATURES_WORKER_QUEUE = "1";
    process.env.REDIS_URL = "redis://localhost:6379";
    expect(isQueueEnabled()).toBe(false);
  });
});

describe("getRedisConnection", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when REDIS_URL is not set", () => {
    delete process.env.REDIS_URL;
    const conn = getRedisConnection();
    expect(conn).toBeNull();
  });
});

describe("STAGE_QUEUE_NAME constant", () => {
  it("equals 'stage:execute'", () => {
    expect(STAGE_QUEUE_NAME).toBe("stage:execute");
  });
});
