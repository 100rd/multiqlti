import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '../src/runner';
import { EvaluatorTamperingError } from '../src/errors';

describe('Out-of-Band Test Runner', () => {
  let tempDirs: string[] = [];

  async function createSandbox(): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-runner-sandbox-'));
    tempDirs.push(tempDir);
    return tempDir;
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (err) {
        // Ignore cleanup errors
      }
    }
    tempDirs = [];
  });

  it('should return a CLEAN verdict with exit code 0 when the command succeeds and files are not modified', async () => {
    const sandbox = await createSandbox();
    
    const testFilePath = path.join(sandbox, 'dummy.test.js');
    await fs.writeFile(testFilePath, '// Original test code');

    const config = {
      testCommand: 'node -e "console.log(\'all tests passed\'); process.exit(0)"',
      testFilesPattern: ['*.test.js'],
      cwd: sandbox
    };

    const verdict = await runTests(config);
    expect(verdict.verdict).toBe('CLEAN');
    expect(verdict.exitCode).toBe(0);
    expect(verdict.stdout).toContain('all tests passed');
  });

  it('should return a FAIL verdict with exit code 1 when the command fails and files are not modified', async () => {
    const sandbox = await createSandbox();
    
    const testFilePath = path.join(sandbox, 'dummy.test.js');
    await fs.writeFile(testFilePath, '// Original test code');

    const config = {
      testCommand: 'node -e "console.error(\'some tests failed\'); process.exit(1)"',
      testFilesPattern: ['*.test.js'],
      cwd: sandbox
    };

    const verdict = await runTests(config);
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.exitCode).toBe(1);
    expect(verdict.stderr).toContain('some tests failed');
  });

  it('should throw EvaluatorTamperingError if a test file is modified during execution', async () => {
    const sandbox = await createSandbox();
    
    const testFilePath = path.join(sandbox, 'dummy.test.js');
    await fs.writeFile(testFilePath, '// Original test code');

    const config = {
      testCommand: `node -e "require('fs').writeFileSync('dummy.test.js', '// Tampered test code')"`,
      testFilesPattern: ['*.test.js'],
      cwd: sandbox
    };

    let error: any = null;
    try {
      await runTests(config);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(EvaluatorTamperingError);
    expect(error.message).toContain('File modified during test execution:');
  });

  it('should throw EvaluatorTamperingError if a test file is deleted during execution', async () => {
    const sandbox = await createSandbox();
    
    const testFilePath = path.join(sandbox, 'dummy.test.js');
    await fs.writeFile(testFilePath, '// Original test code');

    const config = {
      testCommand: `node -e "require('fs').unlinkSync('dummy.test.js')"`,
      testFilesPattern: ['*.test.js'],
      cwd: sandbox
    };

    let error: any = null;
    try {
      await runTests(config);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(EvaluatorTamperingError);
    expect(error.message).toContain('File deleted during test execution:');
  });

  it('should throw EvaluatorTamperingError if a new test file is added during execution', async () => {
    const sandbox = await createSandbox();
    
    const testFilePath = path.join(sandbox, 'dummy.test.js');
    await fs.writeFile(testFilePath, '// Original test code');

    const config = {
      testCommand: `node -e "require('fs').writeFileSync('new.test.js', '// New test file')"`,
      testFilesPattern: ['*.test.js'],
      cwd: sandbox
    };

    let error: any = null;
    try {
      await runTests(config);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(EvaluatorTamperingError);
    expect(error.message).toContain('File added during test execution:');
  });

  it('should normalize backslashes to forward slashes in patterns', async () => {
    const sandbox = await createSandbox();
    
    const testFilePath = path.join(sandbox, 'dummy.test.js');
    await fs.writeFile(testFilePath, '// Original test code');

    const config = {
      testCommand: 'node -e "process.exit(0)"',
      testFilesPattern: ['.\\\\*.test.js'],
      cwd: sandbox
    };

    const verdict = await runTests(config);
    expect(verdict.verdict).toBe('CLEAN');
    expect(verdict.exitCode).toBe(0);
  });
});
