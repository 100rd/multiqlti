import { executeTask } from '../src/wrapper';
import { UnauthorizedExecutionError } from '../src/errors';
import * as fs from 'fs';
import * as path from 'path';

describe('Adversarial & Stress Testing on Transactional Execution', () => {
  let sandboxDir: string;

  beforeEach(() => {
    const uniqueId = Math.random().toString(36).substring(2, 15);
    sandboxDir = path.resolve(__dirname, `sandbox-adv-${uniqueId}`);
    fs.mkdirSync(sandboxDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(sandboxDir)) {
      // Restore permissions of subdirectories to ensure clean delete
      const restorePermissions = (dir: string) => {
        try {
          fs.chmodSync(dir, 0o777);
          fs.readdirSync(dir).forEach(file => {
            const curPath = path.join(dir, file);
            if (fs.statSync(curPath).isDirectory()) {
              restorePermissions(curPath);
            } else {
              fs.chmodSync(curPath, 0o666);
            }
          });
        } catch (e) {}
      };
      restorePermissions(sandboxDir);
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  const createMockToken = (scopes: string[]): string => {
    const payload = { scopes };
    return 'Bearer ' + Buffer.from(JSON.stringify(payload)).toString('base64');
  };

  // --- 1. Command Obfuscation ---
  describe('Command Obfuscation & Quote Interception Bypass', () => {
    it('bypasses "rm -rf" check using "rm -r -f" command structure without token', async () => {
      const targetDir = path.join(sandboxDir, 'sub-dir');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

      const command = 'rm -r -f sub-dir';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow(UnauthorizedExecutionError);

      expect(fs.existsSync(targetDir)).toBe(true);
    });

    it('bypasses "rm -rf" check using quoted commands like \'rm\' -rf without token', async () => {
      const targetDir = path.join(sandboxDir, 'sub-dir');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

      const command = "'rm' -rf sub-dir";

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow(UnauthorizedExecutionError);

      expect(fs.existsSync(targetDir)).toBe(true);
    });

    it('bypasses "deploy" check using quotes like de\'ploy\' without token', async () => {
      const deployScript = path.join(sandboxDir, 'deploy');
      fs.writeFileSync(deployScript, '#!/bin/sh\necho "stealth deployment"\nexit 0');
      fs.chmodSync(deployScript, 0o755);

      const command = "./de'ploy'";

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow(UnauthorizedExecutionError);
    });

    it('bypasses using environment variables or command substitution without token', async () => {
      const targetDir = path.join(sandboxDir, 'sub-dir');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

      const command = 'CMD=rm; $CMD -rf sub-dir';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow(UnauthorizedExecutionError);

      expect(fs.existsSync(targetDir)).toBe(true);
    });

    it('blocks eval command bypass', async () => {
      const targetDir = path.join(sandboxDir, 'sub-dir');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

      const command = 'eval rm -rf sub-dir';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow(UnauthorizedExecutionError);

      expect(fs.existsSync(targetDir)).toBe(true);
    });

    it('blocks prefix command options and arguments bypass (bash -o)', async () => {
      const targetDir = path.join(sandboxDir, 'sub-dir');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

      const command = 'bash -o pipefail -c "rm -rf sub-dir"';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow(UnauthorizedExecutionError);

      expect(fs.existsSync(targetDir)).toBe(true);
    });

    it('blocks prefix command options and arguments bypass (sudo -u)', async () => {
      const targetDir = path.join(sandboxDir, 'sub-dir');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

      const command = 'sudo -u root rm -rf sub-dir';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow(UnauthorizedExecutionError);

      expect(fs.existsSync(targetDir)).toBe(true);
    });

    it('blocks double-quoted subshell/backticks bypass ($(echo rm))', async () => {
      const targetDir = path.join(sandboxDir, 'sub-dir');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

      const command = '"$(echo rm)" -rf sub-dir';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow(UnauthorizedExecutionError);

      expect(fs.existsSync(targetDir)).toBe(true);
    });

    it('blocks double-quoted subshell/backticks bypass (echo $(rm -rf))', async () => {
      const targetDir = path.join(sandboxDir, 'sub-dir');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

      const command = 'echo "$(rm -rf sub-dir)"';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow(UnauthorizedExecutionError);

      expect(fs.existsSync(targetDir)).toBe(true);
    });

    it('blocks variable assignment with space split bypass (CMD="rm -rf")', async () => {
      const targetDir = path.join(sandboxDir, 'sub-dir');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

      const command = 'CMD="rm -rf"; $CMD sub-dir';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow(UnauthorizedExecutionError);

      expect(fs.existsSync(targetDir)).toBe(true);
    });
  });

  // --- 2. Symlinks ---
  describe('Symlink Behavior and Copying Issues', () => {
    it('converts a file symlink to a regular file upon failing task rollback', async () => {
      const realFile = path.join(sandboxDir, 'real.txt');
      fs.writeFileSync(realFile, 'original content');

      const symlinkFile = path.join(sandboxDir, 'link.txt');
      fs.symlinkSync(realFile, symlinkFile);

      expect(fs.lstatSync(symlinkFile).isSymbolicLink()).toBe(true);

      const command = 'node -e "process.exit(1);"';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow();

      expect(fs.existsSync(symlinkFile)).toBe(true);
      expect(fs.lstatSync(symlinkFile).isSymbolicLink()).toBe(true); // Must remain a symlink
      expect(fs.readlinkSync(symlinkFile)).toBe(realFile);
    });

    it('recursively duplicates directory symlinks, destroying the link on rollback', async () => {
      const realDir = path.join(sandboxDir, 'real-dir');
      fs.mkdirSync(realDir);
      fs.writeFileSync(path.join(realDir, 'data.txt'), 'real data');

      const symlinkDir = path.join(sandboxDir, 'link-dir');
      fs.symlinkSync(realDir, symlinkDir, 'dir');

      expect(fs.lstatSync(symlinkDir).isSymbolicLink()).toBe(true);

      const command = 'node -e "process.exit(1);"';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow();

      expect(fs.existsSync(symlinkDir)).toBe(true);
      expect(fs.lstatSync(symlinkDir).isSymbolicLink()).toBe(true); // Must remain a symlink
      expect(fs.readlinkSync(symlinkDir)).toBe(realDir);
    });

    it('crashes with ELOOP (too many symbolic links) on circular symlinks during snapshotting', async () => {
      const circularLink = path.join(sandboxDir, 'link-to-self');
      fs.symlinkSync(sandboxDir, circularLink, 'dir');

      const command = 'node -e "console.log(\'hello\');"';

      const result = await executeTask({
        command,
        cwd: sandboxDir,
      });

      expect(result.exitCode).toBe(0);
      expect(fs.lstatSync(circularLink).isSymbolicLink()).toBe(true);
    });
  });

  // --- 3. Write-Protected Files / Folders ---
  describe('Write-Protected Files & Directories Rollback Failure', () => {
    it('fails to roll back if a directory in cwd is write-protected (permission 0555)', async () => {
      const protectedDir = path.join(sandboxDir, 'protected-dir');
      fs.mkdirSync(protectedDir);
      
      const fileInDir = path.join(protectedDir, 'file.txt');
      fs.writeFileSync(fileInDir, 'original content');

      fs.chmodSync(protectedDir, 0o555); // Read-only directory

      const command = 'node -e "process.exit(1);"';

      await expect(
        executeTask({
          command,
          cwd: sandboxDir,
        })
      ).rejects.toThrow();

      expect(fs.existsSync(protectedDir)).toBe(true);
      expect(fs.existsSync(fileInDir)).toBe(true);
      
      // Let's make it writable again to verify content
      fs.chmodSync(protectedDir, 0o777);
      expect(fs.readFileSync(fileInDir, 'utf8')).toBe('original content');
    });
  });
});
