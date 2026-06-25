const fs = require('fs');
const path = require('path');
const os = require('os');
const Docker = require('dockerode');
const { IsolatedWorkspaceManager } = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(120000); // 2 minutes timeout

describe('IsolatedWorkspaceManager Adversarial Challenges', () => {
  let containersToCleanup = [];
  let dirsToCleanup = [];
  const docker = new Docker();

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-adversarial-'));
    dirsToCleanup.push(dir);
    return dir;
  }

  function registerContainer(container) {
    if (container) {
      containersToCleanup.push(container);
    }
    return container;
  }

  afterEach(async () => {
    // Stop all registered containers
    for (const container of containersToCleanup) {
      try {
        await container.stop();
      } catch (e) {
        // Suppress
      }
    }
    containersToCleanup = [];

    // Delete all temporary directories
    for (const dir of dirsToCleanup) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        // Suppress
      }
    }
    dirsToCleanup = [];
  });

  // 1. Concurrent command execution on the SAME sandbox
  test('should handle multiple concurrent command executions on the same sandbox without interference', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));

    const numConcurrent = 15;
    const promises = Array.from({ length: numConcurrent }, (_, idx) => {
      // Each command sleeps for a short time and then echoes its index
      return container.exec(['sh', '-c', `sleep 0.${idx}; echo "result_${idx}"`]);
    });

    const results = await Promise.all(promises);
    results.forEach((res, idx) => {
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe(`result_${idx}`);
      expect(res.stderr.trim()).toBe('');
    });
  });

  // 2. High-speed, high-volume stdout/stderr output stress test
  test('should handle rapid stdout and stderr output stream pressure', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));

    // Execute command generating 100,000 lines of combined output
    const command = [
      'sh',
      '-c',
      'for i in $(seq 1 50000); do echo "out_$i"; echo "err_$i" >&2; done'
    ];

    const result = await container.exec(command);
    expect(result.exitCode).toBe(0);

    const stdoutLines = result.stdout.trim().split('\n');
    const stderrLines = result.stderr.trim().split('\n');

    expect(stdoutLines.length).toBe(50000);
    expect(stderrLines.length).toBe(50000);
    expect(stdoutLines[49999]).toBe('out_50000');
    expect(stderrLines[49999]).toBe('err_50000');
  });

  // 3. Sandbox B (Read-Only) root fs vs mount fs writes
  test('should allow writing to container root (/tmp) but strictly forbid writing to host workspace mount', async () => {
    const workspaceDir = createTempDir();
    fs.writeFileSync(path.join(workspaceDir, 'host_file.txt'), 'original_content');

    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));

    // Write inside container root's /tmp (should succeed)
    const writeTmpRes = await container.exec(['sh', '-c', 'echo "tmp_write" > /tmp/tmp_file.txt && cat /tmp/tmp_file.txt']);
    expect(writeTmpRes.exitCode).toBe(0);
    expect(writeTmpRes.stdout.trim()).toBe('tmp_write');

    // Write to /workspace/host_file.txt (should fail)
    const writeWorkspaceRes = await container.exec(['sh', '-c', 'echo "malicious_change" > /workspace/host_file.txt']);
    expect(writeWorkspaceRes.exitCode).not.toBe(0);
    expect(writeWorkspaceRes.stderr).toContain('Read-only file system');

    // Verify host file was NOT modified
    const hostContent = fs.readFileSync(path.join(workspaceDir, 'host_file.txt'), 'utf8');
    expect(hostContent.trim()).toBe('original_content');
  });

  // 4. Verify lack of required packages inside bare node:20-alpine
  test('should verify missing packages in the node:20-alpine container', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));

    // Check curl
    const curlRes = await container.exec(['curl', '--version']);
    expect(curlRes.exitCode).toBe(0); // Command found

    // Check python3
    const pythonRes = await container.exec(['python3', '--version']);
    expect(pythonRes.exitCode).toBe(0); // Command found

    // Check sqlite3
    const sqliteRes = await container.exec(['sqlite3', '--version']);
    expect(sqliteRes.exitCode).toBe(0); // Command found
  });

  // 5. Verify container removal on stop
  test('should verify that stop() removes the container from docker daemon', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = await manager.createSandboxA({ workspaceDir });

    const containerId = container.id;
    // Check container exists in docker
    let dockerContainer = docker.getContainer(containerId);
    let inspectData = await dockerContainer.inspect();
    expect(inspectData.State.Running).toBe(true);

    // Stop container
    await container.stop();

    // Check container is removed
    await expect(dockerContainer.inspect()).rejects.toThrow();
  });
});
