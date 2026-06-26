import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { glob } from 'glob';
import { EvaluatorTamperingError } from './errors';

export interface RunnerConfig {
  testCommand: string;
  testFilesPattern: string[];
  cwd?: string;
}

export interface RunVerdict {
  verdict: 'CLEAN' | 'FAIL';
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function calculateFileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function runTests(config: RunnerConfig): Promise<RunVerdict> {
  const cwd = config.cwd || process.cwd();

  // Normalize paths converting backslashes to forward slashes for glob inputs
  const normalizedPatterns = config.testFilesPattern.map(p => p.replace(/\\/g, '/'));

  // 1. Pre-execution Hashing
  const beforeFiles = await glob(normalizedPatterns, {
    cwd,
    absolute: true,
    nodir: true,
  });

  const beforeHashes = new Map<string, string>();
  for (const file of beforeFiles) {
    const hash = await calculateFileHash(file);
    beforeHashes.set(file, hash);
  }

  // 2. Execution
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let spawnError: any = null;

  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(config.testCommand, [], {
        shell: true,
        cwd,
        env: process.env,
      });

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        resolve(code ?? -1);
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  } catch (err) {
    spawnError = err;
  }

  // 3. Post-execution Re-hashing
  const afterFiles = await glob(normalizedPatterns, {
    cwd,
    absolute: true,
    nodir: true,
  });

  const afterHashes = new Map<string, string>();
  for (const file of afterFiles) {
    try {
      const hash = await calculateFileHash(file);
      afterHashes.set(file, hash);
    } catch (err) {
      // If we cannot read the file, it will be detected as deleted or modified
    }
  }

  // 4. Verification
  // Check if files were deleted or modified
  for (const [file, beforeHash] of beforeHashes.entries()) {
    if (!afterHashes.has(file)) {
      throw new EvaluatorTamperingError(`File deleted during test execution: ${file}`);
    }
    if (afterHashes.get(file) !== beforeHash) {
      throw new EvaluatorTamperingError(`File modified during test execution: ${file}`);
    }
  }

  // Check if files were added
  for (const file of afterHashes.keys()) {
    if (!beforeHashes.has(file)) {
      throw new EvaluatorTamperingError(`File added during test execution: ${file}`);
    }
  }

  // If there was a spawn/process error but no tampering was detected, rethrow the spawn error
  if (spawnError) {
    throw spawnError;
  }

  // 5. Output
  const verdict: 'CLEAN' | 'FAIL' = exitCode === 0 ? 'CLEAN' : 'FAIL';

  return {
    verdict,
    exitCode,
    stdout,
    stderr,
  };
}
