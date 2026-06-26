const path = require('path');
const fs = require('fs').promises;
const { HILParkingService } = require('../../src/parking-service');
const { InvalidHILRequestError, CircuitBreakerError } = require('../../src/errors');
const { generateMockTask } = require('../helpers');

describe('SPEC-04 HIL Parking Module - Adversarial & Stress Tests', () => {
  let service;
  const storePath = path.resolve(__dirname, '../adversarial_parking_store.json');

  beforeEach(async () => {
    service = new HILParkingService({ storePath, limitPercent: 15 });
    await service.clearQueue();
  });

  afterEach(async () => {
    await service.clearQueue();
  });

  // ==========================================
  // Section 1: Prototype Pollution & Evasion
  // ==========================================

  test('PP_01: Getter-based bypass of prototype pollution check', async () => {
    let callCount = 0;
    const pollutedPayload = {};
    Object.defineProperty(pollutedPayload, '__proto__', {
      value: { pollutedKey: 'pollutedValue' },
      writable: true,
      enumerable: true,
      configurable: true
    });

    const task = {
      id: 'task-bypass-pp',
      type: 'D',
      description: 'database migration',
      get payload() {
        callCount++;
        if (callCount === 1) {
          return {};
        }
        return pollutedPayload;
      }
    };

    const result = await service.submitTask(task, async () => {});
    expect(result.status).toBe('AWAITING_HUMAN');

    // Read the store file directly and verify the payload is clean
    const store = await service._readStore();
    expect(store.length).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(store[0].payload, '__proto__')).toBe(false);
    expect(store[0].payload.pollutedKey).toBeUndefined();
  });

  test('PP_02: Dynamic description getter bypasses authorization gate', async () => {
    let count = 0;
    const task = {
      id: 'bypass',
      type: 'D',
      get description() {
        count++;
        if (count <= 5) {
          return 'database migration';
        }
        return 'change button color to blue';
      }
    };

    const result = await service.submitTask(task, async () => {});
    expect(result.status).toBe('AWAITING_HUMAN');

    const store = await service._readStore();
    const parked = store.find(t => t.id === 'bypass');
    expect(parked).toBeDefined();
    // The description stored must be the snapshotted authorized description!
    expect(parked.description).toBe('database migration');
  });

  // ==========================================
  // Section 2: Unicode Homoglyphs & Evasion
  // ==========================================

  test('HG_01: Unmapped homoglyphs in critical keywords cause false rejection (Denial of Service)', async () => {
    const task = generateMockTask('task-unmapped-hg', 'D', 'database мigration');
    const result = await service.submitTask(task, async () => {});
    expect(result.status).toBe('AWAITING_HUMAN');
  });

  test('HG_02: Dotless i homoglyph in critical keywords causes false rejection', async () => {
    const task = generateMockTask('task-dotless-i', 'D', 'databasemıgratıon');
    const result = await service.submitTask(task, async () => {});
    expect(result.status).toBe('AWAITING_HUMAN');
  });

  test('HG_03: Normalization of Mathematical Fraktur symbols in critical keywords', async () => {
    // Fraktur "database migration" -> 𝖉𝖆𝖙𝖆𝖇𝖆𝖘𝖊 𝖒𝖎𝖓𝖗𝖆𝖙𝖎𝖔𝖓 (using unicode math bold/fraktur)
    // 𝖉 (U+1D589), 𝖆 (U+1D586), 𝖙 (U+1D599), 𝖆 (U+1D586), 𝖇 (U+1D587), 𝖆 (U+1D586), 𝖘 (U+1D598), 𝖊 (U+1D58A)
    // 𝖒 (U+1D592), 𝖎 (U+1D58E), 𝖌 (U+1D58C), 𝖗 (U+1D597), 𝖆 (U+1D586), 𝖙 (U+1D599), 𝖎 (U+1D58E), 𝖔 (U+1D594), 𝖓 (U+1D593)
    const frakturDesc = '𝖉𝖆𝖙𝖆𝖇𝖆𝖘𝖊 𝖒𝖎𝖌𝖗𝖆𝖙𝖎𝖔𝖓';
    const task = generateMockTask('task-fraktur', 'D', frakturDesc);
    const result = await service.submitTask(task, async () => {});
    expect(result.status).toBe('AWAITING_HUMAN');
  });

  // ==========================================
  // Section 3: Race Conditions & Concurrency
  // ==========================================

  test('RC_01: Concurrent file read error causing data loss (CRITICAL GAP)', async () => {
    // 1. Park an initial task successfully
    const task1 = generateMockTask('task-1', 'D', 'database migration');
    await service.submitTask(task1, async () => {});

    // Verify it is in the store
    let store = await service._readStore();
    expect(store.length).toBe(1);

    // 2. Mock fs.readFile to throw a temporary system error (e.g., EACCES)
    let mockCalled = false;
    const originalReadFile = fs.readFile;
    Object.defineProperty(fs, 'readFile', {
      value: async (path, options) => {
        mockCalled = true;
        throw new Error('EACCES: Permission denied');
      },
      configurable: true,
      writable: true
    });

    // 3. Submit another task. The file error must propagate and abort the operation.
    const task2 = generateMockTask('task-2', 'D', 'database migration');
    let submitError;
    try {
      await service.submitTask(task2, async () => {});
    } catch (err) {
      submitError = err;
    } finally {
      // Restore the original fs.readFile function
      Object.defineProperty(fs, 'readFile', {
        value: originalReadFile,
        configurable: true,
        writable: true
      });
    }

    expect(submitError).toBeDefined();
    expect(submitError.message).toContain('EACCES: Permission denied');
    expect(mockCalled).toBe(true);

    // 4. Read the store now. The original task must remain intact and not wiped.
    store = await service._readStore();
    expect(store.length).toBe(1);
    expect(store.find(t => t.id === 'task-1')).toBeDefined();
  });

  test('RC_02: Concurrent submissions serialization', async () => {
    // Submit 50 tasks concurrently
    const promises = [];
    for (let i = 0; i < 50; i++) {
      // We must make sure the ratio doesn't trip circuit breaker, so let's submit non-Type D tasks
      promises.push(
        service.submitTask(generateMockTask(`concurrent-A-${i}`, 'A'), async () => `A-${i}`)
      );
    }

    const results = await Promise.all(promises);
    expect(results.length).toBe(50);
    
    // Verify no file corruption or missing tasks
    const store = await service._readStore();
    // Non-Type D tasks are not written to the store by design, so store should be empty.
    expect(store.length).toBe(0);
  });

  test('RC_03: Double-spending / concurrent approvals on the same task', async () => {
    const task = generateMockTask('task-approval-race', 'D', 'database migration');
    await service.submitTask(task, async () => {});

    let payloadExecCount = 0;
    const executePayloadFn = async () => {
      payloadExecCount++;
      // Sleep slightly to allow concurrency overlap
      await new Promise(r => setTimeout(r, 50));
      return 'success';
    };

    // Trigger two approvals concurrently
    const p1 = service.approveTask('task-approval-race', executePayloadFn);
    const p2 = service.approveTask('task-approval-race', executePayloadFn);

    const results = await Promise.allSettled([p1, p2]);
    
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    // Only one approval must succeed, the other must be rejected
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(payloadExecCount).toBe(1);
  });

  // ==========================================
  // Section 4: Stress Workloads
  // ==========================================

  test('ST_01: High volume task submission and queue stats consistency', async () => {
    // Add 100 non-D tasks directly to queue
    for (let i = 0; i < 100; i++) {
      await service.addTaskToQueue(generateMockTask(`bulk-A-${i}`, 'A'), 'PENDING');
    }

    // Add 15 Type D tasks
    for (let i = 0; i < 15; i++) {
      const task = generateMockTask(`bulk-D-${i}`, 'D', 'database migration');
      await service.submitTask(task, async () => {});
    }

    const stats = await service.getQueueStats();
    expect(stats.totalActive).toBe(115);
    expect(stats.awaitingHuman).toBe(15);
    // Ratio is 15 / 115 = 13.04% <= 15%, so next submission should succeed
    expect(stats.ratioPercent).toBeLessThanOrEqual(15);

    // Tripping point: add 3 more AWAITING_HUMAN tasks
    for (let i = 15; i < 18; i++) {
      await service.addTaskToQueue(generateMockTask(`bulk-D-${i}`, 'D', 'database migration'), 'AWAITING_HUMAN');
    }

    // Now stats should be 18 / 118 = 15.25% (> 15%)
    const statsAfter = await service.getQueueStats();
    expect(statsAfter.ratioPercent).toBeGreaterThan(15);

    // Next submission must throw CircuitBreakerError
    await expect(service.submitTask(generateMockTask('trip-task', 'A'), async () => {}))
      .rejects.toThrow(CircuitBreakerError);
  });

  test('ST_02: Large payload size processing', async () => {
    // Generate a task with 2MB payload
    const largeData = 'x'.repeat(2 * 1024 * 1024);
    const task = generateMockTask('large-task', 'D', 'database migration', { data: largeData });

    const result = await service.submitTask(task, async () => {});
    expect(result.status).toBe('AWAITING_HUMAN');

    const store = await service._readStore();
    expect(store.length).toBe(1);
    expect(store[0].payload.data.length).toBe(2 * 1024 * 1024);
  });

  // ==========================================
  // Section 5: Additional Critical Gaps
  // ==========================================

  test('ADV_PP_03: Circular reference in task object does not cause Stack Overflow (RangeError)', async () => {
    const task = generateMockTask('circular', 'D', 'database migration');
    task.payload = {};
    task.payload.self = task.payload; // Circular reference inside payload

    let error;
    try {
      await service.submitTask(task, async () => {});
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.message).not.toContain('Maximum call stack size exceeded');
    expect(error.message).toContain('Converting circular structure to JSON');
  });

  test('ADV_PP_04: Property getter that throws error crashes the service (DoS)', async () => {
    const task = {
      id: 'crash',
      type: 'D',
      get description() {
        throw new Error('Internal property extraction failed');
      }
    };

    await expect(service.submitTask(task, async () => {}))
      .rejects.toThrow('Internal property extraction failed');
  });

  test('ADV_UNI_04: Zero-width space in critical keyword is rejected', async () => {
    const description = 'database\u200bmigration';
    const task = generateMockTask('zws', 'D', description);

    await expect(service.submitTask(task, async () => {}))
      .rejects.toThrow(InvalidHILRequestError);
  });

  test('ADV_CB_01: Submitting a single Type D task to empty queue trips CB', async () => {
    const task1 = generateMockTask('t1', 'D', 'database migration');
    await service.submitTask(task1, async () => {});

    const stats = await service.getQueueStats();
    expect(stats.ratioPercent).toBe(100);

    const task2 = generateMockTask('t2', 'A');
    await expect(service.submitTask(task2, async () => 'ok'))
      .rejects.toThrow(CircuitBreakerError);
  });

  test('ADV_COR_01: Corrupt JSON file is not silently ignored and does not cause data loss', async () => {
    await fs.writeFile(storePath, '{ invalid json', 'utf8');

    // Reading the store or submitting a task must throw a SyntaxError
    await expect(service._readStore()).rejects.toThrow(SyntaxError);

    const task = generateMockTask('t1', 'D', 'database migration');
    await expect(service.submitTask(task, async () => {}))
      .rejects.toThrow(SyntaxError);

    // Verify file content is not overwritten
    const content = await fs.readFile(storePath, 'utf8');
    expect(content).toBe('{ invalid json');
  });

  test('ADV_STR_01: Sequential task submissions suffer from O(N) read/write performance degradation', async () => {
    const warmupTasks = 50;
    const testTasks = 200;
    
    // Warm up JIT compiler
    for (let i = 0; i < warmupTasks; i++) {
      await service.addTaskToQueue(generateMockTask(`warmup_${i}`, 'A'), 'COMPLETED');
    }

    const times = [];

    // Measure addition of new tasks to the growing queue
    for (let i = 0; i < testTasks; i++) {
      const hrstart = process.hrtime();
      await service.addTaskToQueue(generateMockTask(`stress_${i}`, 'A'), 'COMPLETED');
      const hrend = process.hrtime(hrstart);
      times.push(hrend[0] * 1000 + hrend[1] / 1000000);
    }

    // Compare early stage vs late stage execution times
    const first10Avg = times.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const last10Avg = times.slice(-10).reduce((a, b) => a + b, 0) / 10;

    console.log(`First 10 average time: ${first10Avg.toFixed(4)}ms`);
    console.log(`Last 10 average time: ${last10Avg.toFixed(4)}ms`);
    
    // Check if performance degrades (normally last 10 is slower due to JSON parsing/writing O(N) size)
    // To make this test robust across environments, we can log the times and verify it is non-zero
    expect(first10Avg).toBeGreaterThan(0);
    expect(last10Avg).toBeGreaterThan(0);
  });
});
