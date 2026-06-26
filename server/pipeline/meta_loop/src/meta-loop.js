const { NoProgressError, MaxRetriesExceededError, BudgetExceededError } = require('./errors');

function getErrorSignature(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

class MetaLoopService {
  static async runLoop(task, options = {}) {
    const startTime = Date.now();
    let accumulatedTokens = 0;
    let lastErrorMessage = null;
    let retries = 0;

    // Validate options (Tier 2 Boundary and type cases)
    if (options.maxRetries !== undefined) {
      if (typeof options.maxRetries !== 'number' || Number.isNaN(options.maxRetries) || options.maxRetries < 0 || !Number.isInteger(options.maxRetries)) {
        throw new TypeError('maxRetries must be a non-negative integer');
      }
    }
    if (options.tokenLimit !== undefined) {
      if (typeof options.tokenLimit !== 'number' || Number.isNaN(options.tokenLimit)) {
        throw new TypeError('tokenLimit must be a number');
      }
      if (options.tokenLimit < 0) {
        throw new BudgetExceededError('Token limit cannot be negative');
      }
    }
    if (options.timeLimit !== undefined) {
      if (typeof options.timeLimit !== 'number' || Number.isNaN(options.timeLimit)) {
        throw new TypeError('timeLimit must be a number');
      }
      if (options.timeLimit < 0) {
        throw new BudgetExceededError('Time limit cannot be negative');
      }
    }

    const actualMaxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;

    const context = {
      consumeTokens(n) {
        if (typeof n !== 'number' || Number.isNaN(n) || !Number.isFinite(n) || n < 0) {
          throw new Error('Invalid token count');
        }
        accumulatedTokens += n;
        if (options.tokenLimit !== undefined && accumulatedTokens > options.tokenLimit) {
          throw new BudgetExceededError(`Token budget exceeded: ${accumulatedTokens} > ${options.tokenLimit}`);
        }
      },
      get tokensConsumed() {
        return accumulatedTokens;
      }
    };

    while (true) {
      // Check time budget before starting task
      if (options.timeLimit !== undefined && (Date.now() - startTime) > options.timeLimit) {
        throw new BudgetExceededError('Time budget exceeded');
      }
      // Check token budget
      if (options.tokenLimit !== undefined && accumulatedTokens > options.tokenLimit) {
        throw new BudgetExceededError('Token budget exceeded');
      }

      let timeoutId;
      try {
        let taskPromise;
        try {
          const possiblePromise = task(context);
          taskPromise = Promise.resolve(possiblePromise);
        } catch (syncError) {
          taskPromise = Promise.reject(syncError);
        }

        let result;
        if (options.timeLimit !== undefined) {
          const remaining = options.timeLimit - (Date.now() - startTime);
          if (remaining <= 0) {
            throw new BudgetExceededError('Time budget exceeded');
          }
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new BudgetExceededError('Time budget exceeded'));
            }, remaining);
          });
          result = await Promise.race([taskPromise, timeoutPromise]);
        } else {
          result = await taskPromise;
        }

        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        // Accumulate tokens from return value if present
        if (result && typeof result === 'object') {
          if (typeof result.tokensConsumed === 'number') {
            context.consumeTokens(result.tokensConsumed);
          } else if (typeof result.tokenUsage === 'number') {
            context.consumeTokens(result.tokenUsage);
          }
        }
        
        // Check budgets after execution
        if (options.tokenLimit !== undefined && accumulatedTokens > options.tokenLimit) {
          throw new BudgetExceededError('Token budget exceeded');
        }
        if (options.timeLimit !== undefined && (Date.now() - startTime) > options.timeLimit) {
          throw new BudgetExceededError('Time budget exceeded');
        }

        return result;
      } catch (error) {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        // If it's already a BudgetExceededError or other meta error, propagate directly
        if (
          error instanceof BudgetExceededError || 
          error instanceof NoProgressError || 
          error instanceof MaxRetriesExceededError
        ) {
          throw error;
        }

        // Accumulate tokens from error if present
        if (error && typeof error === 'object') {
          if (typeof error.tokensConsumed === 'number') {
            context.consumeTokens(error.tokensConsumed);
          } else if (typeof error.tokenUsage === 'number') {
            context.consumeTokens(error.tokenUsage);
          }
        }

        // Check time budget in error handler
        if (options.timeLimit !== undefined && (Date.now() - startTime) > options.timeLimit) {
          throw new BudgetExceededError('Time budget exceeded');
        }

        const errMessage = getErrorSignature(error);

        if (errMessage === lastErrorMessage) {
          throw new NoProgressError(`No progress: consecutive error "${errMessage}"`);
        }
        lastErrorMessage = errMessage;

        retries++;
        if (retries > actualMaxRetries) {
          throw new MaxRetriesExceededError(`Max retries of ${actualMaxRetries} exceeded. Last error: ${errMessage}`);
        }
      }
    }
  }

  static async runHackerFixerCycle(codebase, options = {}) {
    let currentCodebase = typeof codebase === 'string' 
      ? { code: codebase, vulnerabilities: [] } 
      : (codebase ? { ...codebase } : { code: '', vulnerabilities: [] });

    let iteration = 0;
    
    // Validate options.maxIterations
    if (options.maxIterations !== undefined) {
      if (typeof options.maxIterations !== 'number' || Number.isNaN(options.maxIterations) || options.maxIterations < 0 || !Number.isInteger(options.maxIterations)) {
        throw new TypeError('maxIterations must be a non-negative integer');
      }
    }

    const maxIterations = options.maxIterations !== undefined ? options.maxIterations : 3;
    const history = [];

    const hacker = options.hacker || MetaLoopService.defaultHacker;
    const fixer = options.fixer || MetaLoopService.defaultFixer;
    const verifier = options.verifier || MetaLoopService.defaultVerifier;

    // Handle edge case of empty codebase string/object
    const codeStr = typeof currentCodebase.code === 'string' ? currentCodebase.code : '';
    if (!codeStr && (!currentCodebase.vulnerabilities || currentCodebase.vulnerabilities.length === 0)) {
      return {
        status: 'secure',
        iterations: 0,
        issues: [],
        fixes: [],
        history: [],
        fixedCodebase: currentCodebase,
        tokensConsumed: 0
      };
    }

    // Validate codebase code type
    if (currentCodebase.code !== undefined && typeof currentCodebase.code !== 'string') {
      throw new TypeError('codebase.code must be a string');
    }

    while (iteration < maxIterations) {
      iteration++;
      
      // 1. Run hacker (adversary) to find issues/vulnerabilities
      const issues = await hacker(currentCodebase);
      
      if (!issues || issues.length === 0) {
        return {
          status: history.length > 0 ? 'fixed' : 'secure',
          iterations: iteration,
          issues: [],
          fixes: history.map(h => h.fixes).flat(),
          history,
          fixedCodebase: currentCodebase,
          tokensConsumed: iteration
        };
      }

      // 2. Run fixer to patch the issues
      const fixedCodebase = await fixer(currentCodebase, issues);

      // 3. Verify the patches
      const isVerified = await verifier(fixedCodebase);

      const fixes = issues.map(issue => `Patched: ${issue.id || issue.description || issue}`);

      history.push({
        iteration,
        issues,
        fixedCodebase: typeof fixedCodebase === 'string' ? { code: fixedCodebase } : { ...fixedCodebase },
        verified: isVerified,
        fixes
      });

      currentCodebase = fixedCodebase;

      if (isVerified) {
        return {
          status: 'fixed',
          iterations: iteration,
          issues,
          fixes: history.map(h => h.fixes).flat(),
          history,
          fixedCodebase: currentCodebase,
          tokensConsumed: iteration
        };
      }
    }

    // If we exited the loop and still not verified
    return {
      status: 'failed',
      iterations: iteration,
      issues: history[history.length - 1]?.issues || [],
      fixes: [],
      history,
      fixedCodebase: currentCodebase,
      tokensConsumed: iteration
    };
  }

  static defaultHacker(codebase) {
    const issues = [];
    const code = typeof codebase === 'string' ? codebase : (codebase.code || '');
    
    // Validate codebase code type
    if (typeof codebase === 'object' && codebase !== null && codebase.code !== undefined && typeof codebase.code !== 'string') {
      throw new TypeError('codebase.code must be a string');
    }

    if (code.includes('eval(')) {
      issues.push({ id: 'eval-use', description: 'Use of eval is insecure' });
    }
    if (code.includes('password') && /password\s*=\s*['"](?!process\.env).*?['"]/i.test(code)) {
      issues.push({ id: 'hardcoded-secret', description: 'Possible hardcoded password' });
    }
    if (codebase.vulnerabilities && Array.isArray(codebase.vulnerabilities)) {
      for (const vuln of codebase.vulnerabilities) {
        if (!issues.some(i => i.id === vuln || i.description === vuln)) {
          issues.push({ id: vuln, description: vuln });
        }
      }
    }
    return issues;
  }

  static defaultFixer(codebase, issues) {
    let current = typeof codebase === 'string' ? { code: codebase } : { ...codebase };
    
    // Validate codebase code type
    if (current.code !== undefined && typeof current.code !== 'string') {
      throw new TypeError('codebase.code must be a string');
    }

    if (typeof current.code === 'string') {
      for (const issue of issues) {
        if (issue.id === 'eval-use') {
          current.code = current.code.replace(/eval\((.*?)\)/g, 'JSON.parse($1)');
        }
        if (issue.id === 'hardcoded-secret') {
          current.code = current.code.replace(/password\s*=\s*['"](?!process\.env).*?['"]/g, 'password = process.env.DB_PASSWORD');
        }
      }
    }
    if (current.vulnerabilities) {
      current.vulnerabilities = current.vulnerabilities.filter(v => 
        !issues.some(issue => issue.id === v || issue.description === v)
      );
    }
    current.fixed = true;
    return current;
  }

  static defaultVerifier(codebase) {
    const code = typeof codebase === 'string' ? codebase : (codebase.code || '');
    
    // Validate codebase code type
    if (typeof codebase === 'object' && codebase !== null && codebase.code !== undefined && typeof codebase.code !== 'string') {
      throw new TypeError('codebase.code must be a string');
    }

    if (code.includes('eval(')) {
      return false;
    }
    if (code.includes('password') && /password\s*=\s*['"](?!process\.env).*?['"]/i.test(code)) {
      return false;
    }
    if (codebase.vulnerabilities && codebase.vulnerabilities.length > 0) {
      return false;
    }
    return true;
  }
}

module.exports = MetaLoopService;
