import { executeTask } from '../src/wrapper';
import { UnauthorizedExecutionError } from '../src/errors';
import * as fs from 'fs';
import * as path from 'path';

describe('Transactional Task Execution & Authorization Wrapper', () => {
  let sandboxDir: string;

  beforeEach(() => {
    // Create a unique sandbox directory for each test
    const uniqueId = Math.random().toString(36).substring(2, 15);
    sandboxDir = path.resolve(__dirname, `sandbox-${uniqueId}`);
    fs.mkdirSync(sandboxDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up the sandbox directory after each test
    if (fs.existsSync(sandboxDir)) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  // Helper to construct token
  const createMockToken = (scopes: string[]): string => {
    const payload = { scopes };
    return 'Bearer ' + Buffer.from(JSON.stringify(payload)).toString('base64');
  };

  describe('R1: Transactional Rollback Wrapper', () => {
    it('should successfully execute a task and persist changes on exit code 0', async () => {
      const command = 'node -e "const fs = require(\'fs\'); fs.writeFileSync(\'new-file.txt\', \'hello success\');"';
      
      const result = await executeTask({
        command,
        cwd: sandboxDir,
      });

      expect(result.exitCode).toBe(0);
      
      const filePath = path.join(sandboxDir, 'new-file.txt');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe('hello success');
    });

    it('should automatically roll back file creation if the task exits with code 1', async () => {
      // Create a pre-existing base file to ensure it's not affected
      const baseFile = path.join(sandboxDir, 'base.txt');
      fs.writeFileSync(baseFile, 'original content');

      // Command that creates a new file and then exits with 1
      const command = 'node -e "const fs = require(\'fs\'); fs.writeFileSync(\'failed-file.txt\', \'should be rolled back\'); process.exit(1);"';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow();

      // Assertions
      const failedFile = path.join(sandboxDir, 'failed-file.txt');
      expect(fs.existsSync(failedFile)).toBe(false); // Created file is deleted
      expect(fs.existsSync(baseFile)).toBe(true);    // Pre-existing file is kept
      expect(fs.readFileSync(baseFile, 'utf8')).toBe('original content');
    });

    it('should automatically roll back modified files if the task fails', async () => {
      const baseFile = path.join(sandboxDir, 'base.txt');
      fs.writeFileSync(baseFile, 'original content');

      // Command that overwrites the existing file and then exits with 1
      const command = 'node -e "const fs = require(\'fs\'); fs.writeFileSync(\'base.txt\', \'modified content\'); process.exit(1);"';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow();

      // Assertions
      expect(fs.existsSync(baseFile)).toBe(true);
      expect(fs.readFileSync(baseFile, 'utf8')).toBe('original content'); // Modification rolled back
    });

    it('should automatically roll back deleted files if the task fails', async () => {
      const baseFile = path.join(sandboxDir, 'base.txt');
      fs.writeFileSync(baseFile, 'original content');

      // Command that deletes the file and then exits with 1
      const command = 'node -e "const fs = require(\'fs\'); fs.unlinkSync(\'base.txt\'); process.exit(1);"';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow();

      // Assertions
      expect(fs.existsSync(baseFile)).toBe(true);
      expect(fs.readFileSync(baseFile, 'utf8')).toBe('original content'); // Deletion rolled back
    });
  });

  describe('R2: High-Risk Command Interceptor', () => {
    describe('rm -rf command restriction', () => {
      it('should throw UnauthorizedExecutionError when attempting rm -rf without a token', async () => {
        const command = 'rm -rf sub-dir';
        
        await expect(
          executeTask({
            command,
            cwd: sandboxDir,
          })
        ).rejects.toThrow(UnauthorizedExecutionError);
      });

      it('should throw UnauthorizedExecutionError when token is invalid format', async () => {
        const command = 'rm -rf sub-dir';
        
        await expect(
          executeTask({
            command,
            cwd: sandboxDir,
            token: 'fs:delete', // invalid format (no Bearer)
          })
        ).rejects.toThrow(UnauthorizedExecutionError);
      });

      it('should throw UnauthorizedExecutionError when token lacks fs:delete scope', async () => {
        const command = 'rm -rf sub-dir';
        const token = createMockToken(['other:scope']);

        await expect(
          executeTask({
            command,
            cwd: sandboxDir,
            token,
          })
        ).rejects.toThrow(UnauthorizedExecutionError);
      });

      it('should execute successfully when token has fs:delete scope', async () => {
        // Setup a directory to delete
        const targetDir = path.join(sandboxDir, 'sub-dir');
        fs.mkdirSync(targetDir);
        fs.writeFileSync(path.join(targetDir, 'file.txt'), 'test');

        const command = 'rm -rf sub-dir';
        const token = createMockToken(['fs:delete']);

        const result = await executeTask({
          command,
          cwd: sandboxDir,
          token,
        });

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(targetDir)).toBe(false);
      });
    });

    describe('deploy command restriction', () => {
      it('should throw UnauthorizedExecutionError when attempting deploy without a token', async () => {
        const command = './deploy';

        await expect(
          executeTask({
            command,
            cwd: sandboxDir,
          })
        ).rejects.toThrow(UnauthorizedExecutionError);
      });

      it('should throw UnauthorizedExecutionError when token lacks deploy scope', async () => {
        const command = './deploy';
        const token = createMockToken(['fs:delete']);

        await expect(
          executeTask({
            command,
            cwd: sandboxDir,
            token,
          })
        ).rejects.toThrow(UnauthorizedExecutionError);
      });

      it('should execute successfully when token has deploy scope', async () => {
        // Create a local mock deploy script in the sandbox
        const deployScript = path.join(sandboxDir, 'deploy');
        fs.writeFileSync(deployScript, '#!/bin/sh\necho "deployed successfully"\nexit 0');
        fs.chmodSync(deployScript, 0o755); // make it executable

        const command = './deploy';
        const token = createMockToken(['deploy']);

        const result = await executeTask({
          command,
          cwd: sandboxDir,
          token,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('deployed successfully');
      });
    });
  });
});
