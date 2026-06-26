import { executeTask } from '../src/wrapper';
import { UnauthorizedExecutionError } from '../src/errors';
import * as fs from 'fs';
import * as path from 'path';

describe('Adversarial Bypasses on Wrapper Command Validation', () => {
  let sandboxDir: string;

  beforeEach(() => {
    const uniqueId = Math.random().toString(36).substring(2, 15);
    sandboxDir = path.resolve(__dirname, `sandbox-bypass-${uniqueId}`);
    fs.mkdirSync(sandboxDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(sandboxDir)) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('bypasses rm check using eval with double quotes', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = 'eval "rm -rf sub-dir"';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    // Let's check if the directory was deleted (bypass succeeded)
    const exists = fs.existsSync(targetDir);
    console.log('--- eval "rm -rf" bypass check ---');
    console.log('Error thrown:', errorThrown?.message || errorThrown);
    console.log('Directory exists:', exists);

    // If bypass succeeds, exists is false and errorThrown is null/not UnauthorizedExecutionError
    // But we WANT it to be secure, so if it's secure, it should throw UnauthorizedExecutionError
    // We expect it to FAIL (bypass succeeds) due to tokenization bug, so exists will be false.
    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
    expect(exists).toBe(true);
  });

  it('bypasses rm check using pipe to bash', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = 'echo "rm -rf sub-dir" | bash';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    const exists = fs.existsSync(targetDir);
    console.log('--- pipe to bash bypass check ---');
    console.log('Error thrown:', errorThrown?.message || errorThrown);
    console.log('Directory exists:', exists);

    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
    expect(exists).toBe(true);
  });

  it('bypasses rm check using xargs', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = 'echo sub-dir | xargs rm -rf';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    const exists = fs.existsSync(targetDir);
    console.log('--- xargs bypass check ---');
    console.log('Error thrown:', errorThrown?.message || errorThrown);
    console.log('Directory exists:', exists);

    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
    expect(exists).toBe(true);
  });

  it('bypasses deploy check using deploy.sh suffix', async () => {
    const deployScript = path.join(sandboxDir, 'deploy.sh');
    fs.writeFileSync(deployScript, '#!/bin/sh\necho "stealth deployment"\nexit 0');
    fs.chmodSync(deployScript, 0o755);

    const command = './deploy.sh';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    console.log('--- deploy.sh bypass check ---');
    console.log('Error thrown:', errorThrown?.message || errorThrown);

    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
  });

  it('bypasses rm check using zsh -c', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = 'zsh -c "rm -rf sub-dir"';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    const exists = fs.existsSync(targetDir);
    console.log('--- zsh -c bypass check ---');
    console.log('Error thrown:', errorThrown?.message || errorThrown);
    console.log('Directory exists:', exists);

    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
    expect(exists).toBe(true);
  });

  it('bypasses rm check using custom env script prefix', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    // Create a local executable named "env" that runs rm -rf
    const localEnv = path.join(sandboxDir, 'env');
    fs.writeFileSync(localEnv, `#!/bin/sh\nrm -rf "${targetDir}"\nexit 0`);
    fs.chmodSync(localEnv, 0o755);

    // We run ./env to delete sub-dir. The validator thinks ./env is the shell prefix env!
    const command = './env';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    const exists = fs.existsSync(targetDir);
    console.log('--- ./env bypass check ---');
    console.log('Error thrown:', errorThrown?.message || errorThrown);
    console.log('Directory exists:', exists);

    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
    expect(exists).toBe(true);
  });

  it('bypasses rm check using sudo -h option', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = 'sudo -h localhost rm -rf sub-dir';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    const exists = fs.existsSync(targetDir);
    console.log('--- sudo -h bypass check ---');
    console.log('Error thrown:', errorThrown?.message || errorThrown);
    console.log('Directory exists:', exists);

    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
    expect(exists).toBe(true);
  });

  it('bypasses rm check using bash -O option', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = 'bash -O extglob -c "rm -rf sub-dir"';

    let errorThrown: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      errorThrown = e;
    }

    const exists = fs.existsSync(targetDir);
    console.log('--- bash -O bypass check ---');
    console.log('Error thrown:', errorThrown?.message || errorThrown);
    console.log('Directory exists:', exists);

    expect(errorThrown).toBeInstanceOf(UnauthorizedExecutionError);
    expect(exists).toBe(true);
  });
});

