import { executeTask } from '../src/wrapper';
import { UnauthorizedExecutionError } from '../src/errors';
import * as fs from 'fs';
import * as path from 'path';

describe('Challenger Verification: Authorization Bypasses', () => {
  let sandboxDir: string;

  beforeEach(() => {
    const uniqueId = Math.random().toString(36).substring(2, 15);
    sandboxDir = path.resolve(__dirname, `sandbox-chal-${uniqueId}`);
    fs.mkdirSync(sandboxDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(sandboxDir)) {
      // Make sure everything is writable so we can delete it
      const makeWritable = (dir: string) => {
        try {
          fs.chmodSync(dir, 0o777);
          fs.readdirSync(dir).forEach(file => {
            const curPath = path.join(dir, file);
            if (fs.lstatSync(curPath).isDirectory()) {
              makeWritable(curPath);
            } else if (!fs.lstatSync(curPath).isSymbolicLink()) {
              fs.chmodSync(curPath, 0o666);
            }
          });
        } catch (e) {}
      };
      makeWritable(sandboxDir);
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('bypasses authorization check using backticks', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = '`echo rm` -rf sub-dir';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
  });

  it('bypasses authorization check using $(command substitution)', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = '$(echo rm) -rf sub-dir';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
  });

  it('bypasses authorization check using exec prefix', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = 'exec rm -rf sub-dir';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
  });

  it('bypasses authorization check using unset variable concatenation', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = 'rm$UNSET_VAR -rf sub-dir';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
  });

  it('bypasses authorization check using glob/wildcard matching for command name', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = '/bin/r? -rf sub-dir';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
  });

  it('blocks eval command bypass', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = 'eval rm -rf sub-dir';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
  });

  it('blocks prefix command options and arguments bypass (bash -o)', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = 'bash -o pipefail -c "rm -rf sub-dir"';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
  });

  it('blocks prefix command options and arguments bypass (sudo -u)', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = 'sudo -u root rm -rf sub-dir';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
  });

  it('blocks double-quoted subshell/backticks bypass ($(echo rm))', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = '"$(echo rm)" -rf sub-dir';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
  });

  it('blocks double-quoted subshell/backticks bypass (echo $(rm -rf))', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = 'echo "$(rm -rf sub-dir)"';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
  });

  it('blocks variable assignment with space split bypass (CMD="rm -rf")', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = 'CMD="rm -rf"; $CMD sub-dir';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
  });

  // --- Robustness / Edge Cases ---

  it('handles write-protected files and directories during rollback successfully', async () => {
    const protectedDir = path.join(sandboxDir, 'protected-dir');
    fs.mkdirSync(protectedDir);
    const fileInDir = path.join(protectedDir, 'file.txt');
    fs.writeFileSync(fileInDir, 'original content');

    fs.chmodSync(fileInDir, 0o444);
    fs.chmodSync(protectedDir, 0o555);

    const command = 'node -e "process.exit(1);"';

    await expect(
      executeTask({
        command,
        cwd: sandboxDir,
      })
    ).rejects.toThrow();

    expect(fs.existsSync(protectedDir)).toBe(true);
    expect(fs.existsSync(fileInDir)).toBe(true);
    fs.chmodSync(protectedDir, 0o777);
    fs.chmodSync(fileInDir, 0o666);
    expect(fs.readFileSync(fileInDir, 'utf8')).toBe('original content');
  });

  it('handles deeply nested file/directory layouts on failure and successfully rolls back', async () => {
    let currentDir = sandboxDir;
    for (let i = 0; i < 10; i++) {
      currentDir = path.join(currentDir, `level${i}`);
      fs.mkdirSync(currentDir);
      fs.writeFileSync(path.join(currentDir, 'file.txt'), `content-${i}`);
    }

    const command = 'node -e "const fs = require(\'fs\'); ' +
      'fs.writeFileSync(\'level0/level1/level2/file.txt\', \'hacked\'); ' +
      'fs.unlinkSync(\'level0/level1/level2/level3/file.txt\'); ' +
      'process.exit(1);"';

    await expect(
      executeTask({
        command,
        cwd: sandboxDir,
      })
    ).rejects.toThrow();

    let checkDir = sandboxDir;
    for (let i = 0; i < 10; i++) {
      checkDir = path.join(checkDir, `level${i}`);
      const filePath = path.join(checkDir, 'file.txt');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(`content-${i}`);
    }
  });

  it('handles circular symlink chain without crashing or loop issues', async () => {
    const dirA = path.join(sandboxDir, 'dirA');
    fs.mkdirSync(dirA);
    const linkB = path.join(dirA, 'linkB');
    fs.symlinkSync(dirA, linkB, 'dir');

    const command = 'node -e "process.exit(0);"';

    const result = await executeTask({
      command,
      cwd: sandboxDir,
    });

    expect(result.exitCode).toBe(0);
    expect(fs.lstatSync(linkB).isSymbolicLink()).toBe(true);
  });

  it('crashes snapshotting if an existing file in cwd has 0000 permissions', async () => {
    const zeroFile = path.join(sandboxDir, 'zero.txt');
    fs.writeFileSync(zeroFile, 'secret content');
    fs.chmodSync(zeroFile, 0o000);

    const command = 'node -e "process.exit(0);"';

    // The snapshot phase should fail because we cannot read zero.txt to copy it,
    // causing executeTask to throw an error and fail closed.
    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    console.log('Unreadable file snapshot result:', { errorThrown });
    expect(errorThrown).not.toBeNull();
    expect(errorThrown.code).toBe('EACCES');
  });
});
