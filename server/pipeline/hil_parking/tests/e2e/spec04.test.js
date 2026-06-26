const path = require('path');
const fs = require('fs').promises;
const { HILParkingService } = require('../../src/parking-service');
const { InvalidHILRequestError, CircuitBreakerError } = require('../../src/errors');
const { generateMockTask } = require('../helpers');

describe('SPEC-04 HIL Parking Module', () => {
  let service;
  const storePath = path.resolve(__dirname, '../test_parking_store.json');

  beforeEach(async () => {
    service = new HILParkingService({ storePath, limitPercent: 15 });
    await service.clearQueue();
  });

  afterEach(async () => {
    await service.clearQueue();
  });

  // ==========================================
  // Tier 1: Feature Coverage (17 Tests)
  // ==========================================

  // Feature 1.1: HIL Parking Mechanism (6 Tests)

  test('T1_PM_01: Submitting a valid Type D task writes its state as AWAITING_HUMAN in the local JSON data store', async () => {
    const task = generateMockTask('t1', 'D', 'database migration');
    const result = await service.submitTask(task, async () => {});
    expect(result.status).toBe('AWAITING_HUMAN');
    expect(result.parked).toBe(true);

    const store = await service._readStore();
    expect(store.length).toBe(1);
    expect(store[0].id).toBe('t1');
    expect(store[0].status).toBe('AWAITING_HUMAN');
  });

  test('T1_PM_02: Submitting a valid Type D task does NOT execute the task payload (suspends execution)', async () => {
    const task = generateMockTask('t2', 'D', 'database migration');
    let executed = false;
    const result = await service.submitTask(task, async () => {
      executed = true;
    });
    expect(result.status).toBe('AWAITING_HUMAN');
    expect(executed).toBe(false);
  });

  test('T1_PM_03: Submitting a Type A/B/C/E task executes the payload directly and returns a completed status without parking it', async () => {
    const task = generateMockTask('t3', 'A', 'some normal task');
    let executed = false;
    const result = await service.submitTask(task, async () => {
      executed = true;
      return 'payload_result';
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.parked).toBe(false);
    expect(result.result).toBe('payload_result');
    expect(executed).toBe(true);

    const store = await service._readStore();
    expect(store.length).toBe(0);
  });

  test('T1_PM_04: Approving an AWAITING_HUMAN task executes the payload and updates state to COMPLETED in the store', async () => {
    const task = generateMockTask('t4', 'D', 'database migration');
    await service.submitTask(task, async () => {});

    let executed = false;
    const result = await service.approveTask('t4', async () => {
      executed = true;
      return 'approved_result';
    });

    expect(result).toBe('approved_result');
    expect(executed).toBe(true);

    const store = await service._readStore();
    expect(store[0].status).toBe('COMPLETED');
  });

  test('T1_PM_05: Rejecting an AWAITING_HUMAN task updates state to REJECTED in the store without executing the payload', async () => {
    const task = generateMockTask('t5', 'D', 'database migration');
    await service.submitTask(task, async () => {});

    const rejected = await service.rejectTask('t5');
    expect(rejected.status).toBe('REJECTED');

    const store = await service._readStore();
    expect(store[0].status).toBe('REJECTED');
  });

  test('T1_PM_06: Approving a task that throws an error during payload execution transitions the state to FAILED in the store', async () => {
    const task = generateMockTask('t6', 'D', 'database migration');
    await service.submitTask(task, async () => {});

    await expect(service.approveTask('t6', async () => {
      throw new Error('execution error');
    })).rejects.toThrow('execution error');

    const store = await service._readStore();
    expect(store[0].status).toBe('FAILED');
  });

  // Feature 1.2: Type D Authorization Gate (6 Tests)

  test('T1_AG_01: Task with critical persistent state keyword (production persistent state) is successfully authorized and parked', async () => {
    const task = generateMockTask('t7', 'D', 'This task accesses production persistent state.');
    const result = await service.submitTask(task, async () => {});
    expect(result.status).toBe('AWAITING_HUMAN');
  });

  test('T1_AG_02: Task with database migration description (database migration) is successfully authorized and parked', async () => {
    const task = generateMockTask('t8', 'D', 'Perform a critical database migration now.');
    const result = await service.submitTask(task, async () => {});
    expect(result.status).toBe('AWAITING_HUMAN');
  });

  test('T1_AG_03: Attempting to categorize a harmless UI tweak (change button color to blue) as Type D throws InvalidHILRequestError', async () => {
    const task = generateMockTask('t9', 'D', 'change button color to blue');
    await expect(service.submitTask(task, async () => {}))
      .rejects.toThrow(InvalidHILRequestError);
  });

  test('T1_AG_04: Semantic verification is case-insensitive and normalized (NFKD), successfully permitting complex spacing/casing', async () => {
    const task = generateMockTask('t10', 'D', '  DaTaBaSe   MiGrAtIoN  ');
    const result = await service.submitTask(task, async () => {});
    expect(result.status).toBe('AWAITING_HUMAN');
  });

  test('T1_AG_05: Submitting a non-Type D task with a harmless UI tweak description passes without gate check', async () => {
    const task = generateMockTask('t11', 'A', 'change button color to blue');
    const result = await service.submitTask(task, async () => {
      return 'ok';
    });
    expect(result.status).toBe('COMPLETED');
  });

  test('T1_AG_06: Submitting a task containing both UI tweak and critical keywords (modify database to save button color) is authorized (critical keyword takes precedence)', async () => {
    const task = generateMockTask('t12', 'D', 'modify database to save button color');
    const result = await service.submitTask(task, async () => {});
    expect(result.status).toBe('AWAITING_HUMAN');
  });

  // Feature 1.3: Circuit Breaker (5 Tests)

  test('T1_CB_01: Submitting any task when the active queue contains >15% AWAITING_HUMAN tasks immediately throws CircuitBreakerError', async () => {
    await service.addTaskToQueue(generateMockTask('active1', 'A'), 'PENDING');
    await service.addTaskToQueue(generateMockTask('awaiting1', 'D', 'database migration'), 'AWAITING_HUMAN');

    const nextTask = generateMockTask('next', 'A');
    await expect(service.submitTask(nextTask, async () => {}))
      .rejects.toThrow(CircuitBreakerError);
  });

  test('T1_CB_02: Submitting any task when the active queue contains <=15% AWAITING_HUMAN tasks succeeds', async () => {
    for (let i = 1; i <= 9; i++) {
      await service.addTaskToQueue(generateMockTask(`active${i}`, 'A'), 'PENDING');
    }
    await service.addTaskToQueue(generateMockTask('awaiting1', 'D', 'database migration'), 'AWAITING_HUMAN');

    const nextTask = generateMockTask('next', 'A');
    const result = await service.submitTask(nextTask, async () => 'done');
    expect(result.status).toBe('COMPLETED');
  });

  test('T1_CB_03: Submitting a task to an empty queue succeeds', async () => {
    const task = generateMockTask('t1', 'A');
    const result = await service.submitTask(task, async () => 'success');
    expect(result.status).toBe('COMPLETED');
  });

  test('T1_CB_04: Non-Type D tasks are also blocked by the circuit breaker when the threshold is exceeded', async () => {
    await service.addTaskToQueue(generateMockTask('awaiting1', 'D', 'database migration'), 'AWAITING_HUMAN');
    const nextTask = generateMockTask('next', 'A');
    await expect(service.submitTask(nextTask, async () => {}))
      .rejects.toThrow(CircuitBreakerError);
  });

  test('T1_CB_05: Clearing the queue resets the circuit breaker completely', async () => {
    await service.addTaskToQueue(generateMockTask('awaiting1', 'D', 'database migration'), 'AWAITING_HUMAN');
    await expect(service.submitTask(generateMockTask('next1', 'A'), async () => {}))
      .rejects.toThrow(CircuitBreakerError);

    await service.clearQueue();

    const result = await service.submitTask(generateMockTask('next2', 'A'), async () => 'reset');
    expect(result.status).toBe('COMPLETED');
  });


  // ==========================================
  // Tier 2: Boundary & Corner Cases (15 Tests)
  // ==========================================

  // Feature 2.1: Parking Mechanism Boundaries (6 Tests)

  test('T2_PM_01: Submitting a null or undefined task object throws a validation error', async () => {
    await expect(service.submitTask(null, async () => {}))
      .rejects.toThrow('Task must be a valid object');
    await expect(service.submitTask(undefined, async () => {}))
      .rejects.toThrow('Task must be a valid object');
  });

  test('T2_PM_02: Submitting a task missing id or type throws a validation error', async () => {
    await expect(service.submitTask({ type: 'A' }, async () => {}))
      .rejects.toThrow('Task must contain a valid string ID');
    await expect(service.submitTask({ id: 't1' }, async () => {}))
      .rejects.toThrow('Task must contain a valid string type');
  });

  test('T2_PM_03: Submitting a task with an invalid/unsupported type throws a validation error', async () => {
    await expect(service.submitTask({ id: 't1', type: 'Z' }, async () => {}))
      .rejects.toThrow('Unsupported task type: Z');
  });

  test('T2_PM_04: Approving a non-existent task ID throws a validation error', async () => {
    await expect(service.approveTask('non_existent', async () => {}))
      .rejects.toThrow('Task with ID non_existent not found');
  });

  test('T2_PM_05: Approving a task that is already COMPLETED or REJECTED throws a validation error', async () => {
    const task = generateMockTask('t1', 'D', 'database migration');
    await service.submitTask(task, async () => {});

    await service.approveTask('t1', async () => 'first');

    await expect(service.approveTask('t1', async () => 'second'))
      .rejects.toThrow('Task with status COMPLETED cannot be approved');

    const task2 = generateMockTask('t2', 'D', 'database migration');
    await service.submitTask(task2, async () => {});
    await service.rejectTask('t2');

    await expect(service.approveTask('t2', async () => 'third'))
      .rejects.toThrow('Task with status REJECTED cannot be approved');
  });

  test('T2_PM_06: Rejecting a non-existent task ID throws a validation error', async () => {
    await expect(service.rejectTask('non_existent'))
      .rejects.toThrow('Task with ID non_existent not found');
  });

  // Feature 2.2: Authorization Gate Boundaries (5 Tests)

  test('T2_AG_01: Submitting a Type D task with a missing or empty description throws InvalidHILRequestError', async () => {
    await expect(service.submitTask({ id: 't1', type: 'D' }, async () => {}))
      .rejects.toThrow(InvalidHILRequestError);
    await expect(service.submitTask({ id: 't2', type: 'D', description: '' }, async () => {}))
      .rejects.toThrow(InvalidHILRequestError);
    await expect(service.submitTask({ id: 't3', type: 'D', description: '   ' }, async () => {}))
      .rejects.toThrow(InvalidHILRequestError);
  });

  test('T2_AG_02: Submitting a Type D task with a description containing only whitespace/symbols throws InvalidHILRequestError', async () => {
    await expect(service.submitTask({ id: 't1', type: 'D', description: '!!! @@@' }, async () => {}))
      .rejects.toThrow(InvalidHILRequestError);
  });

  test('T2_AG_03: Unicode homoglyph attack on UI keywords is detected and correctly rejected (e.g. Cyrillic a in ui tweak)', async () => {
    const task = generateMockTask('t1', 'D', 'ui tweаk');
    await expect(service.submitTask(task, async () => {}))
      .rejects.toThrow(InvalidHILRequestError);
  });

  test('T2_AG_04: Unicode homoglyph correction on critical keywords is successfully resolved and accepted (e.g. Cyrillic a in database migration)', async () => {
    const task = generateMockTask('t1', 'D', 'dаtаbаsе mіgrаtіоn');
    const result = await service.submitTask(task, async () => {});
    expect(result.status).toBe('AWAITING_HUMAN');
  });

  test('T2_AG_05: Object prototype pollution attacks (e.g. including __proto__ in the task) are shielded', async () => {
    const task = JSON.parse('{"id": "t1", "type": "D", "description": "database migration", "__proto__": {"polluted": "yes"}}');
    await expect(service.submitTask(task, async () => {}))
      .rejects.toThrow('Prototype pollution attempt detected');

    const nestedTask = {
      id: 't2',
      type: 'D',
      description: 'database migration',
      payload: JSON.parse('{"constructor": {"prototype": {"polluted": "yes"}}}')
    };
    await expect(service.submitTask(nestedTask, async () => {}))
      .rejects.toThrow('Prototype pollution attempt detected');
  });

  // Feature 2.3: Circuit Breaker Boundaries (4 Tests)

  test('T2_CB_01: Exactly 15% AWAITING_HUMAN tasks allows submission (boundary limit)', async () => {
    for (let i = 1; i <= 17; i++) {
      await service.addTaskToQueue(generateMockTask(`active${i}`, 'A'), 'PENDING');
    }
    for (let i = 1; i <= 3; i++) {
      await service.addTaskToQueue(generateMockTask(`awaiting${i}`, 'D', 'database migration'), 'AWAITING_HUMAN');
    }

    const nextTask = generateMockTask('next', 'A');
    const result = await service.submitTask(nextTask, async () => 'success');
    expect(result.status).toBe('COMPLETED');
  });

  test('T2_CB_02: Just above 15% (e.g. 15.1% or 16%) blocks submission', async () => {
    for (let i = 1; i <= 16; i++) {
      await service.addTaskToQueue(generateMockTask(`active${i}`, 'A'), 'PENDING');
    }
    for (let i = 1; i <= 3; i++) {
      await service.addTaskToQueue(generateMockTask(`awaiting${i}`, 'D', 'database migration'), 'AWAITING_HUMAN');
    }

    const nextTask = generateMockTask('next', 'A');
    await expect(service.submitTask(nextTask, async () => {}))
      .rejects.toThrow(CircuitBreakerError);
  });

  test('T2_CB_03: Queue with 100% AWAITING_HUMAN tasks blocks submission', async () => {
    await service.addTaskToQueue(generateMockTask('awaiting1', 'D', 'database migration'), 'AWAITING_HUMAN');
    const nextTask = generateMockTask('next', 'A');
    await expect(service.submitTask(nextTask, async () => {}))
      .rejects.toThrow(CircuitBreakerError);
  });

  test('T2_CB_04: Large active queue size (e.g., 100 tasks, 15 awaiting human = 15%) allows submission, while 16 awaiting human blocks it', async () => {
    for (let i = 1; i <= 85; i++) {
      await service.addTaskToQueue(generateMockTask(`active${i}`, 'A'), 'PENDING');
    }
    for (let i = 1; i <= 15; i++) {
      await service.addTaskToQueue(generateMockTask(`awaiting${i}`, 'D', 'database migration'), 'AWAITING_HUMAN');
    }

    const nextTask1 = generateMockTask('next1', 'A');
    const result = await service.submitTask(nextTask1, async () => 'ok');
    expect(result.status).toBe('COMPLETED');

    await service.addTaskToQueue(generateMockTask('awaiting16', 'D', 'database migration'), 'AWAITING_HUMAN');
    const nextTask2 = generateMockTask('next2', 'A');
    await expect(service.submitTask(nextTask2, async () => {}))
      .rejects.toThrow(CircuitBreakerError);
  });


  // ==========================================
  // Tier 3: Combinatorial & Cross-Feature (3 Tests)
  // ==========================================

  test('T3_MIX_01: Submitting a Type D task, approving it (reducing awaiting ratio), and submitting a subsequent task to ensure correct state transition and threshold updates', async () => {
    const task1 = generateMockTask('t1', 'D', 'database migration');
    await service.submitTask(task1, async () => {});

    await expect(service.submitTask(generateMockTask('t2', 'A'), async () => {}))
      .rejects.toThrow(CircuitBreakerError);

    await service.approveTask('t1', async () => 'approved');

    const result = await service.submitTask(generateMockTask('t3', 'A'), async () => 'succeed');
    expect(result.status).toBe('COMPLETED');
  });

  test('T3_MIX_02: Exception Precedence: Submitting an invalid Type D task when the circuit breaker is already open. The CircuitBreakerError must throw first because the circuit breaker is evaluated before the authorization gate', async () => {
    await service.addTaskToQueue(generateMockTask('awaiting1', 'D', 'database migration'), 'AWAITING_HUMAN');

    const invalidTask = generateMockTask('invalidD', 'D', 'change button color to blue');

    await expect(service.submitTask(invalidTask, async () => {}))
      .rejects.toThrow(CircuitBreakerError);
  });

  test('T3_MIX_03: Multi-task execution flow with mixed types (A, B, C, D) and verifying file store integrity under concurrent writes', async () => {
    for (let i = 1; i <= 50; i++) {
      await service.addTaskToQueue(generateMockTask(`active${i}`, 'A'), 'PENDING');
    }

    const promises = [];
    for (let i = 1; i <= 5; i++) {
      promises.push(
        service.submitTask(generateMockTask(`concurrentD_${i}`, 'D', 'database migration'), async () => {})
      );
    }
    for (let i = 1; i <= 5; i++) {
      promises.push(
        service.submitTask(generateMockTask(`concurrentA_${i}`, 'A'), async () => `A_${i}`)
      );
    }

    const results = await Promise.all(promises);
    expect(results.length).toBe(10);

    const store = await service._readStore();
    expect(store.length).toBe(55);

    const awaitingCount = store.filter(t => t.status === 'AWAITING_HUMAN').length;
    expect(awaitingCount).toBe(5);
  });


  // ==========================================
  // Tier 4: Real-World Scenarios (3 Tests)
  // ==========================================

  test('T4_SC_01: High-load pipeline scenario: 10 Type A tasks run, 2 Type D tasks are parked. Queue ratio is 16.6% (2/12), which trips the circuit breaker. A human approves one task, dropping the ratio to 9.09% (1/11), resetting the circuit breaker and allowing the pipeline to resume', async () => {
    for (let i = 1; i <= 10; i++) {
      await service.addTaskToQueue(generateMockTask(`taskA_${i}`, 'A'), 'RUNNING');
    }
    await service.submitTask(generateMockTask('taskD_1', 'D', 'database migration'), async () => {});

    const resD2 = await service.submitTask(generateMockTask('taskD_2', 'D', 'database migration'), async () => {});
    expect(resD2.status).toBe('AWAITING_HUMAN');

    const nextTask = generateMockTask('taskA_11', 'A');
    await expect(service.submitTask(nextTask, async () => {}))
      .rejects.toThrow(CircuitBreakerError);

    await service.approveTask('taskD_1', async () => 'approved');

    const result = await service.submitTask(nextTask, async () => 'resumed');
    expect(result.status).toBe('COMPLETED');
  });

  test('T4_SC_02: Security Breach Recovery: Adversarial agent attempts to push a database migration task using Type D with a lazy/harmless UI description. The gate rejects it, and it does not block the pipeline', async () => {
    const harmlessUI = generateMockTask('badTask', 'D', 'margin tweak for database view');
    await expect(service.submitTask(harmlessUI, async () => {}))
      .rejects.toThrow(InvalidHILRequestError);

    const taskA = generateMockTask('goodTask', 'A');
    const result = await service.submitTask(taskA, async () => 'fine');
    expect(result.status).toBe('COMPLETED');
  });

  test('T4_SC_03: Recovering from payload execution failure: A parked task is approved but its execution throws an error. The task state transitions to FAILED in the store, and is counted as non-active', async () => {
    const task = generateMockTask('t1', 'D', 'database migration');
    await service.submitTask(task, async () => {});

    await expect(service.approveTask('t1', async () => {
      throw new Error('payload crash');
    })).rejects.toThrow('payload crash');

    const store = await service._readStore();
    expect(store[0].status).toBe('FAILED');

    const stats = await service.getQueueStats();
    expect(stats.totalActive).toBe(0);
    expect(stats.awaitingHuman).toBe(0);
    expect(stats.ratioPercent).toBe(0);
  });
});
