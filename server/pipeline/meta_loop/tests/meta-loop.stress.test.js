const MetaLoopService = require('../src/meta-loop');
const { NoProgressError, MaxRetriesExceededError, BudgetExceededError } = require('../src/errors');

describe('MetaLoop Adversarial & Stress Test Suite (Hardened)', () => {

  // ==========================================
  // 1. Non-Error Objects as Exceptions (Progress Check Bug)
  // ==========================================
  test('STRESS_NON_ERROR_OBJECT_CONSECUTIVE_PSEUDO_MATCH: should NOT throw NoProgressError when throwing two different non-Error objects', async () => {
    let count = 0;
    const task = async () => {
      count++;
      if (count === 1) {
        throw { message: 'First unique error details' };
      }
      if (count === 2) {
        throw { message: 'Second unique error details' };
      }
      if (count === 3) {
        throw { message: 'Second unique error details' };
      }
      return 'success';
    };

    // The two exceptions are different, so it should not throw NoProgressError on count = 2.
    // It should retry again and then throw NoProgressError on count = 3 when it throws the same error.
    await expect(MetaLoopService.runLoop(task, { maxRetries: 5 }))
      .rejects
      .toThrow(NoProgressError);

    expect(count).toBe(3);
  });

  // ==========================================
  // 2. String/NaN type in maxRetries (Infinite Loop Bypass)
  // ==========================================
  test('STRESS_INVALID_MAX_RETRIES_INFINITE_LOOP: should reject with TypeError when maxRetries is a non-numeric string', async () => {
    let count = 0;
    const stressTask = async () => {
      count++;
      throw new Error(`Error count: ${count}`);
    };

    await expect(MetaLoopService.runLoop(stressTask, { maxRetries: 'invalid-string' }))
      .rejects
      .toThrow(TypeError);
  });

  // ==========================================
  // 3. runHackerFixerCycle Budget Bypass inside runLoop
  // ==========================================
  test('STRESS_HF_BUDGET_BYPASS: runHackerFixerCycle should consume tokens and fail when budget is exceeded', async () => {
    let taskRunCount = 0;
    const task = async (ctx) => {
      taskRunCount++;
      const codebase = {
        code: 'eval("insecure"); const password = "123";',
        vulnerabilities: []
      };
      // This codebase contains vulnerabilities and takes 1 iteration to fix, consuming 1 token
      const result = await MetaLoopService.runHackerFixerCycle(codebase);
      return result;
    };

    // Under tokenLimit: 0, it should throw BudgetExceededError
    await expect(MetaLoopService.runLoop(task, { tokenLimit: 0 }))
      .rejects
      .toThrow(BudgetExceededError);
  });

  // ==========================================
  // 4. Asynchronous timeLimit Bypass (Hanging Task)
  // ==========================================
  test('STRESS_ASYNC_TIMELIMIT_BYPASS: runLoop should immediately interrupt hanging async task when timeLimit is reached', async () => {
    const timeLimit = 50;
    const startTime = Date.now();

    const hangingTask = async () => {
      // Simulate a task that hangs or takes longer than the timeLimit
      await new Promise(resolve => setTimeout(resolve, 150));
      return 'done';
    };

    // runLoop uses Promise.race to abort early, so it throws immediately upon time limit exhaustion.
    await expect(MetaLoopService.runLoop(hangingTask, { timeLimit }))
      .rejects
      .toThrow(BudgetExceededError);

    const duration = Date.now() - startTime;
    // The duration should be very close to the timeLimit (50ms) and definitely less than 100ms.
    expect(duration).toBeLessThan(100);
  });

  // ==========================================
  // 5. Invalid token consumption in error/success
  // ==========================================
  test('STRESS_INVALID_TOKEN_CONSUMPTION_IN_ERROR: non-numeric or negative tokenUsage inside error throws generic Error instead of BudgetExceededError', async () => {
    const task = async () => {
      const err = new Error('Some error');
      err.tokensConsumed = -100; // Negative token usage
      throw err;
    };

    await expect(MetaLoopService.runLoop(task))
      .rejects
      .toThrow('Invalid token count');
  });

  test('STRESS_NON_ERROR_OBJECT_TOKEN_ACCUMULATION: runLoop successfully extracts tokensConsumed from non-Error exception objects', async () => {
    let count = 0;
    const task = async () => {
      count++;
      if (count === 1) {
        throw { message: 'First error', tokensConsumed: 8 };
      }
      return 'success';
    };

    // First run throws { tokensConsumed: 8 }. Limit is 5.
    await expect(MetaLoopService.runLoop(task, { tokenLimit: 5 }))
      .rejects
      .toThrow(BudgetExceededError);
  });

  // ==========================================
  // 6. Hacker-Fixer with invalid code type
  // ==========================================
  test('STRESS_HF_INVALID_CODE_TYPE_THROWS: defaultHacker throws TypeError if codebase.code is not a string but vulnerabilities exist', async () => {
    const codebase = {
      code: 12345, // Number instead of string
      vulnerabilities: ['vuln-1']
    };

    await expect(MetaLoopService.runHackerFixerCycle(codebase))
      .rejects
      .toThrow(TypeError);
  });
});
