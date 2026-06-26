const MetaLoopService = require('../src/meta-loop');
const { NoProgressError, MaxRetriesExceededError, BudgetExceededError } = require('../src/errors');

describe('MetaLoop E2E Jest Test Suite', () => {

  // ==========================================
  // TIER 1: Feature Coverage (10 Tests)
  // ==========================================

  describe('Tier 1: Feature Coverage - Stop Conditions', () => {
    // 1. T1_STOP_RETRY_LIMIT: Throws MaxRetriesExceededError when task fails maxRetries (3) times.
    test('T1_STOP_RETRY_LIMIT: should throw MaxRetriesExceededError when retries exceed default limit of 3', async () => {
      let count = 0;
      const task = async () => {
        count++;
        throw new Error(`Failure ${count}`);
      };

      await expect(MetaLoopService.runLoop(task, { maxRetries: 3 }))
        .rejects
        .toThrow(MaxRetriesExceededError);
      
      // 1 initial run + 3 retries = 4 runs total
      expect(count).toBe(4);
    });

    // 2. T1_STOP_TOKEN_LIMIT: Throws BudgetExceededError when tokenLimit is exceeded.
    test('T1_STOP_TOKEN_LIMIT: should throw BudgetExceededError when token usage exceeds limit', async () => {
      const task = async (ctx) => {
        ctx.consumeTokens(10);
        ctx.consumeTokens(1); // Exceeds limit of 10
        return 'success';
      };

      await expect(MetaLoopService.runLoop(task, { tokenLimit: 10 }))
        .rejects
        .toThrow(BudgetExceededError);
    });

    // 3. T1_STOP_TIMEOUT_LIMIT: Throws BudgetExceededError when task exceeds timeLimit.
    test('T1_STOP_TIMEOUT_LIMIT: should throw BudgetExceededError when time limit is exceeded', async () => {
      const task = async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'done';
      };

      await expect(MetaLoopService.runLoop(task, { timeLimit: 20 }))
        .rejects
        .toThrow(BudgetExceededError);
    });

    // 4. T1_STOP_NO_PROGRESS_SIMPLE: Throws NoProgressError if the task throws the exact same string error twice in immediate succession.
    test('T1_STOP_NO_PROGRESS_SIMPLE: should throw NoProgressError on consecutive identical string errors', async () => {
      let count = 0;
      const task = async () => {
        count++;
        throw new Error('Static Error message');
      };

      await expect(MetaLoopService.runLoop(task, { maxRetries: 5 }))
        .rejects
        .toThrow(NoProgressError);
      
      // Should stop on the 2nd run because of identical consecutive errors
      expect(count).toBe(2);
    });

    // 5. T1_STOP_NO_PROGRESS_CUSTOM: Throws NoProgressError if task throws the exact same custom exception twice in immediate succession.
    test('T1_STOP_NO_PROGRESS_CUSTOM: should throw NoProgressError on consecutive identical custom exception messages', async () => {
      class CustomException extends Error {
        constructor() {
          super('Custom Exception Occurred');
          this.name = 'CustomException';
        }
      }

      let count = 0;
      const task = async () => {
        count++;
        throw new CustomException();
      };

      await expect(MetaLoopService.runLoop(task, { maxRetries: 5 }))
        .rejects
        .toThrow(NoProgressError);
      
      expect(count).toBe(2);
    });
  });

  describe('Tier 1: Feature Coverage - Hacker-Fixer', () => {
    // 6. T1_HF_RUN_CYCLE: Hacker-Fixer cycle runs successfully when codebase is vulnerable (e.g. eval) and default fixer fixes it, verifier approves.
    test('T1_HF_RUN_CYCLE: should complete hacker-fixer cycle successfully for vulnerable codebase', async () => {
      const codebase = {
        code: 'function execute(x) { eval(x); }',
        vulnerabilities: []
      };

      const result = await MetaLoopService.runHackerFixerCycle(codebase);
      expect(result.status).toBe('fixed');
      expect(result.iterations).toBe(1);
      expect(result.fixes.length).toBeGreaterThan(0);
      expect(result.fixedCodebase.code).not.toContain('eval(');
    });

    // 7. T1_HF_HACKER_EXEC: Hacker execution discovers vulnerabilities (e.g., eval or hardcoded-secret).
    test('T1_HF_HACKER_EXEC: should execute hacker module to detect vulnerabilities', async () => {
      const codebase = {
        code: 'const password = "admin_secret";',
        vulnerabilities: []
      };

      const issues = await MetaLoopService.defaultHacker(codebase);
      expect(issues.length).toBe(1);
      expect(issues[0].id).toBe('hardcoded-secret');
    });

    // 8. T1_HF_FIXER_EXEC: Fixer execution fixes the vulnerabilities.
    test('T1_HF_FIXER_EXEC: should execute fixer module to patch detected issues', async () => {
      const codebase = {
        code: 'const password = "admin_secret";',
        vulnerabilities: []
      };
      const issues = [{ id: 'hardcoded-secret', description: 'Possible hardcoded password' }];

      const patched = await MetaLoopService.defaultFixer(codebase, issues);
      expect(patched.code).toContain('process.env.DB_PASSWORD');
      expect(patched.code).not.toContain('admin_secret');
    });

    // 9. T1_HF_VERIFY_SUCCESS: Verifier successfully validates and returns true.
    test('T1_HF_VERIFY_SUCCESS: should verify secure codebase successfully', () => {
      const codebase = {
        code: 'const password = process.env.DB_PASSWORD;',
        vulnerabilities: []
      };
      const isVerified = MetaLoopService.defaultVerifier(codebase);
      expect(isVerified).toBe(true);
    });

    // 10. T1_HF_FAILURE_REPORT: Hacker-Fixer returns failed status if the patch cannot be verified (verifier always returns false) within iterations.
    test('T1_HF_FAILURE_REPORT: should report failure if verifier continuously rejects fixes', async () => {
      const codebase = {
        code: 'dangerous code',
        vulnerabilities: ['vulnerability-1']
      };

      // Mock options where verifier always returns false
      const options = {
        hacker: async (cb) => cb.vulnerabilities.map(v => ({ id: v })),
        fixer: async (cb, issues) => cb, // No-op fixer
        verifier: async (cb) => false, // Always rejects
        maxIterations: 2
      };

      const result = await MetaLoopService.runHackerFixerCycle(codebase, options);
      expect(result.status).toBe('failed');
      expect(result.iterations).toBe(2);
      expect(result.issues.length).toBe(1);
    });
  });

  // ==========================================
  // TIER 2: Boundary & Corner Cases (10 Tests)
  // ==========================================

  describe('Tier 2: Boundary & Corner Cases', () => {
    // 11. T2_STOP_MAX_RETRIES_0: Throws MaxRetriesExceededError on the first failure when maxRetries is 0.
    test('T2_STOP_MAX_RETRIES_0: should throw MaxRetriesExceededError immediately on first failure if maxRetries is 0', async () => {
      let count = 0;
      const task = async () => {
        count++;
        throw new Error('First run failure');
      };

      await expect(MetaLoopService.runLoop(task, { maxRetries: 0 }))
        .rejects
        .toThrow(MaxRetriesExceededError);
      
      expect(count).toBe(1);
    });

    // 12. T2_STOP_NEG_TOKEN_LIMIT: Throws BudgetExceededError when tokenLimit is negative.
    test('T2_STOP_NEG_TOKEN_LIMIT: should throw BudgetExceededError if tokenLimit is negative', async () => {
      const task = async () => 'ok';
      await expect(MetaLoopService.runLoop(task, { tokenLimit: -5 }))
        .rejects
        .toThrow(BudgetExceededError);
    });

    // 13. T2_STOP_NEG_TIME_LIMIT: Throws BudgetExceededError when timeLimit is negative.
    test('T2_STOP_NEG_TIME_LIMIT: should throw BudgetExceededError if timeLimit is negative', async () => {
      const task = async () => 'ok';
      await expect(MetaLoopService.runLoop(task, { timeLimit: -100 }))
        .rejects
        .toThrow(BudgetExceededError);
    });

    // 14. T2_STOP_NO_PROGRESS_CONSECUTIVE: A task throwing Error A -> Error B -> Error A does not trigger NoProgressError.
    test('T2_STOP_NO_PROGRESS_CONSECUTIVE: alternating errors (A -> B -> A) should not trigger NoProgressError', async () => {
      let count = 0;
      const task = async () => {
        count++;
        if (count === 1) throw new Error('Error A');
        if (count === 2) throw new Error('Error B');
        if (count === 3) throw new Error('Error A');
        return 'success';
      };

      const result = await MetaLoopService.runLoop(task, { maxRetries: 3 });
      expect(result).toBe('success');
      expect(count).toBe(4);
    });

    // 15. T2_STOP_SHORT_TIMEOUT: Very short time budget (e.g., 1ms) throws BudgetExceededError.
    test('T2_STOP_SHORT_TIMEOUT: should throw BudgetExceededError under a very tight timeout budget', async () => {
      const task = async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return 'ok';
      };

      await expect(MetaLoopService.runLoop(task, { timeLimit: 1 }))
        .rejects
        .toThrow(BudgetExceededError);
    });

    // 16. T2_HF_EMPTY_CODEBASE: Returns status "secure" and 0 iterations if codebase is empty string or has no vulnerabilities/code.
    test('T2_HF_EMPTY_CODEBASE: should return status secure for empty codebase', async () => {
      const result1 = await MetaLoopService.runHackerFixerCycle('');
      expect(result1.status).toBe('secure');
      expect(result1.iterations).toBe(0);

      const result2 = await MetaLoopService.runHackerFixerCycle({ code: '', vulnerabilities: [] });
      expect(result2.status).toBe('secure');
      expect(result2.iterations).toBe(0);
    });

    // 17. T2_HF_NO_ISSUES: Returns status "secure" if codebase has code but no vulnerabilities are found.
    test('T2_HF_NO_ISSUES: should return status secure if hacker finds no issues in codebase', async () => {
      const codebase = {
        code: 'const x = 42; console.log(x);',
        vulnerabilities: []
      };

      const result = await MetaLoopService.runHackerFixerCycle(codebase);
      expect(result.status).toBe('secure');
      expect(result.iterations).toBe(1); // Ran 1 check
      expect(result.issues).toEqual([]);
    });

    // 18. T2_STOP_HIGH_RETRIES_RECOVERY: Task succeeds on the 9th retry with maxRetries = 10 (asserts it doesn\'t throw and returns the successful result).
    test('T2_STOP_HIGH_RETRIES_RECOVERY: should recover and succeed on the 9th retry with high retry limit', async () => {
      let count = 0;
      const task = async () => {
        count++;
        if (count < 10) {
          throw new Error(`Temp failure ${count}`); // Alternating message
        }
        return 'final_success';
      };

      const result = await MetaLoopService.runLoop(task, { maxRetries: 10 });
      expect(result).toBe('final_success');
      expect(count).toBe(10); // 1st run + 9 retries
    });

    // 19. T2_STOP_TOKEN_LIMIT_EXACT: Token limit exactly matches consumed tokens vs exceeds by 1.
    test('T2_STOP_TOKEN_LIMIT_EXACT: should succeed when token limit is exactly matched, but fail when exceeded by 1', async () => {
      // Exactly matches
      const taskExact = async (ctx) => {
        ctx.consumeTokens(5);
        return 'exact';
      };
      const resExact = await MetaLoopService.runLoop(taskExact, { tokenLimit: 5 });
      expect(resExact).toBe('exact');

      // Exceeds by 1
      const taskExceeded = async (ctx) => {
        ctx.consumeTokens(5);
        ctx.consumeTokens(1);
        return 'exceeded';
      };
      await expect(MetaLoopService.runLoop(taskExceeded, { tokenLimit: 5 }))
        .rejects
        .toThrow(BudgetExceededError);
    });

    // 20. T2_STOP_SYNC_TASK: runLoop works correctly with a synchronous task.
    test('T2_STOP_SYNC_TASK: should execute synchronous tasks correctly', async () => {
      let runCount = 0;
      const syncTask = (ctx) => {
        runCount++;
        ctx.consumeTokens(2);
        if (runCount < 2) {
          throw new Error('Sync error');
        }
        return 'sync_success';
      };

      const result = await MetaLoopService.runLoop(syncTask, { maxRetries: 2, tokenLimit: 10 });
      expect(result).toBe('sync_success');
      expect(runCount).toBe(2);
    });
  });

  // ==========================================
  // TIER 3: Combinatorial & Cross-Feature Tests (2 Tests)
  // ==========================================

  describe('Tier 3: Combinatorial & Cross-Feature Tests', () => {
    // 21. T3_COMBO_HF_IN_RETRY_LOOP: runHackerFixerCycle runs inside runLoop. Hacker-Fixer completes successfully on first try, and the outer loop registers success.
    test('T3_COMBO_HF_IN_RETRY_LOOP: should successfully run Hacker-Fixer cycle inside the retry runLoop', async () => {
      const task = async (ctx) => {
        ctx.consumeTokens(2);
        const codebase = { code: 'eval("hack")', vulnerabilities: [] };
        const cycleResult = await MetaLoopService.runHackerFixerCycle(codebase);
        ctx.consumeTokens(3); // extra tokens
        return cycleResult;
      };

      const result = await MetaLoopService.runLoop(task, { maxRetries: 2, tokenLimit: 10 });
      expect(result.status).toBe('fixed');
      expect(result.fixedCodebase.code).not.toContain('eval(');
    });

    // 22. T3_COMBO_HF_BUDGET_EXCEEDED: runHackerFixerCycle runs inside runLoop, but the task consumes too many tokens, exceeding the outer loop's token budget and throwing BudgetExceededError.
    test('T3_COMBO_HF_BUDGET_EXCEEDED: should throw BudgetExceededError when Hacker-Fixer cycle tasks exceed outer budget limit', async () => {
      const task = async (ctx) => {
        ctx.consumeTokens(10);
        // Exceed budget inside
        ctx.consumeTokens(1);
        return 'should_not_reach';
      };

      await expect(MetaLoopService.runLoop(task, { tokenLimit: 10 }))
        .rejects
        .toThrow(BudgetExceededError);
    });
  });

  // ==========================================
  // TIER 4: Real-World Scenarios (5 Tests)
  // ==========================================

  describe('Tier 4: Real-World Scenarios', () => {
    // 23. T4_REAL_VARIABLE_RECOVERY: Simulates an LLM agent that fails with Error A (1st), then recovers to write slightly better code but fails with Error B (2nd), and finally writes correct code (3rd) and succeeds.
    test('T4_REAL_VARIABLE_RECOVERY: should recover in a real agent loop with changing errors', async () => {
      let turn = 0;
      const agentTask = async () => {
        turn++;
        if (turn === 1) {
          throw new Error('SyntaxError: unexpected token');
        }
        if (turn === 2) {
          throw new Error('TypeError: undefined is not a function');
        }
        return { output: 'Compiled successfully', status: 200 };
      };

      const result = await MetaLoopService.runLoop(agentTask, { maxRetries: 3 });
      expect(result.status).toBe(200);
      expect(result.output).toBe('Compiled successfully');
      expect(turn).toBe(3);
    });

    // 24. T4_REAL_TOKEN_ACCUMULATION: Simulates an LLM agent that retries multiple times. Each retry consumes tokens (e.g. 5 tokens per call). Total tokens exceed limit on the 3rd retry, throwing BudgetExceededError.
    test('T4_REAL_TOKEN_ACCUMULATION: should accumulate tokens across multiple retries and throw BudgetExceededError', async () => {
      let attempts = 0;
      const agentTask = async (ctx) => {
        attempts++;
        ctx.consumeTokens(5); // Consumes 5 tokens per attempt
        throw new Error(`Attempt ${attempts} failed`);
      };

      // 1st attempt: 5 tokens. 2nd attempt: 10 tokens. 3rd attempt: 15 tokens -> exceeds 12.
      await expect(MetaLoopService.runLoop(agentTask, { maxRetries: 5, tokenLimit: 12 }))
        .rejects
        .toThrow(BudgetExceededError);

      expect(attempts).toBe(3);
    });

    // 25. T4_REAL_HF_REPATCH_CYCLE: Hacker finds a vulnerability. Fixer applies patch 1, but it fails verification (so verifier returns false). In the next iteration, fixer applies patch 2 which passes verification, resulting in status "fixed".
    test('T4_REAL_HF_REPATCH_CYCLE: should support multi-round hacker-fixer remediation with temporary patch failure', async () => {
      const codebase = {
        code: 'unsafe codebase',
        vulnerabilities: ['vuln-A']
      };

      let patchRound = 0;
      const customHacker = async (cb) => {
        return cb.vulnerabilities.map(v => ({ id: v }));
      };
      
      const customFixer = async (cb, issues) => {
        patchRound++;
        const newCb = { ...cb };
        if (patchRound === 1) {
          newCb.patchVersion = 1;
        } else {
          newCb.patchVersion = 2;
          newCb.vulnerabilities = [];
        }
        return newCb;
      };

      const customVerifier = async (cb) => {
        return cb.patchVersion === 2;
      };

      const result = await MetaLoopService.runHackerFixerCycle(codebase, {
        hacker: customHacker,
        fixer: customFixer,
        verifier: customVerifier,
        maxIterations: 3
      });

      expect(result.status).toBe('fixed');
      expect(result.iterations).toBe(2);
      expect(result.fixedCodebase.patchVersion).toBe(2);
      expect(result.fixedCodebase.vulnerabilities.length).toBe(0);
    });

    // 26. T4_REAL_ALTERNATING_ERRORS: Simulates an agent that fluctuates between two errors (A -> B -> A -> B) and successfully completes on the 5th attempt without triggering NoProgressError or exceeding maxRetries (e.g., maxRetries = 5).
    test('T4_REAL_ALTERNATING_ERRORS: should succeed after alternating errors without triggering NoProgressError', async () => {
      let count = 0;
      const agentTask = async () => {
        count++;
        if (count === 1) throw new Error('Error A');
        if (count === 2) throw new Error('Error B');
        if (count === 3) throw new Error('Error A');
        if (count === 4) throw new Error('Error B');
        return 'success_val';
      };

      const result = await MetaLoopService.runLoop(agentTask, { maxRetries: 5 });
      expect(result).toBe('success_val');
      expect(count).toBe(5);
    });

    // 27. T4_REAL_END_TO_END_PIPELINE: A full autonomous agent cycle: runs a task that generates code, passes it to Hacker-Fixer for audit/remediation, and returns the verified codebase under time and token budgets.
    test('T4_REAL_END_TO_END_PIPELINE: full autonomous cycle with code generation, audit, fix, verification and budget checks', async () => {
      let taskRuns = 0;
      
      const pipelineTask = async (ctx) => {
        taskRuns++;
        ctx.consumeTokens(4);

        if (taskRuns === 1) {
          // Generates vulnerable code
          const rawCode = 'function auth(p) { eval(p); }';
          const audit = await MetaLoopService.runHackerFixerCycle(rawCode);
          if (audit.status === 'fixed') {
            return {
              code: audit.fixedCodebase.code,
              tokensConsumed: 2 // reports additional tokens
            };
          }
          throw new Error('Audit failed to fix raw code');
        }

        return { code: 'const safe = true;', tokensConsumed: 1 };
      };

      // Run under total token budget of 10
      const finalResult = await MetaLoopService.runLoop(pipelineTask, {
        maxRetries: 2,
        tokenLimit: 10,
        timeLimit: 1000
      });

      expect(finalResult.code).not.toContain('eval(');
      expect(taskRuns).toBe(1);
    });
  });
});
