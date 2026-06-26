const MetaLoopService = require('../src/meta-loop');
const { NoProgressError, MaxRetriesExceededError, BudgetExceededError } = require('../src/errors');

describe('MetaLoop Challenger Stress Tests (Hardened)', () => {

  // 1. NaN Token Budget Bypass via direct consumeTokens call
  test('Token budget bypass via NaN value in consumeTokens', async () => {
    const task = async (ctx) => {
      // Consume NaN tokens - should throw Invalid token count immediately
      ctx.consumeTokens(NaN);
      // Consume a large amount of tokens afterwards
      ctx.consumeTokens(1000000);
      return 'bypassed';
    };

    // Budget limit is 10, task should throw 'Invalid token count' and reject
    await expect(
      MetaLoopService.runLoop(task, { tokenLimit: 10 })
    ).rejects.toThrow('Invalid token count');
  });

  // 2. Token budget bypass via NaN returned in result / thrown during retry
  test('Token budget bypass via NaN in returned tokensConsumed during retry', async () => {
    let attempt = 0;
    const task = async (ctx) => {
      attempt++;
      if (attempt === 1) {
        // Return or throw NaN on first attempt - should throw Invalid token count
        const err = new Error('First attempt fail');
        err.tokensConsumed = NaN;
        throw err;
      }
      ctx.consumeTokens(1000000);
      return 'bypassed_on_retry';
    };

    await expect(
      MetaLoopService.runLoop(task, { tokenLimit: 10, maxRetries: 2 })
    ).rejects.toThrow('Invalid token count');
  });

  // 3. Option Validation Bypass - maxRetries = 'invalid'
  test('Retry limit bypass via invalid maxRetries string option', async () => {
    let runs = 0;
    const task = async () => {
      runs++;
      throw new Error(`Error ${runs}`);
    };

    // This should immediately throw TypeError due to invalid option type.
    await expect(
      MetaLoopService.runLoop(task, { maxRetries: 'invalid_string' })
    ).rejects.toThrow(TypeError);
  });

  // 4. Error Coercion false positive in NoProgressError
  test('NoProgressError false positive when throwing different non-Error objects', async () => {
    let count = 0;
    const task = async () => {
      count++;
      if (count === 1) {
        throw { type: 'validation', detail: 'Username is empty' };
      } else {
        throw { type: 'auth', detail: 'Unauthorized access' };
      }
    };

    // These are completely different objects/errors, so NoProgressError should NOT be thrown on the second run.
    // It should run the 3rd time (where consecutive auth errors occur) and then throw NoProgressError.
    await expect(MetaLoopService.runLoop(task, { maxRetries: 5 }))
      .rejects
      .toThrow(NoProgressError);
    
    expect(count).toBe(3); // Stopped on the 3rd run due to true consecutive auth errors
  });

  // 5. Hacker-Fixer Verification Bypass via env Comment
  test('Hacker-Fixer verification bypass via comment containing "env"', () => {
    const codebase = {
      code: 'const password = "my_super_secret_admin_password"; // env placeholder',
      vulnerabilities: []
    };

    // The default verifier should reject hardcoded passwords, even if the comment contains 'env'.
    const isVerified = MetaLoopService.defaultVerifier(codebase);
    expect(isVerified).toBe(false); // Properly rejected
  });

  // 6. Hacker-Fixer maxIterations: 0 logical OR bug
  test('Hacker-Fixer maxIterations: 0 defaults to 3 iterations', async () => {
    const codebase = {
      code: 'eval(x)',
      vulnerabilities: []
    };

    let hackerCount = 0;
    const customHacker = async (cb) => {
      hackerCount++;
      return [{ id: 'eval-use' }];
    };

    const result = await MetaLoopService.runHackerFixerCycle(codebase, {
      maxIterations: 0,
      hacker: customHacker,
      verifier: async () => false
    });

    expect(result.status).toBe('failed');
    expect(hackerCount).toBe(0); // Should perform 0 iterations
    expect(result.iterations).toBe(0);
  });

  // 7. Time budget bypass via invalid timeLimit
  test('Time limit bypass via invalid timeLimit option', async () => {
    const task = async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return 'ok';
    };

    // Should throw TypeError synchronously / rejects on invalid option type
    await expect(
      MetaLoopService.runLoop(task, { timeLimit: 'invalid_time' })
    ).rejects.toThrow(TypeError);
  });

});
