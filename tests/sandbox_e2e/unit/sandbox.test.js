const fs = require('fs');
const path = require('path');
const os = require('os');
const IsolatedWorkspaceManager = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(180000);

describe('IsolatedWorkspaceManager Integration Tests', () => {
  let manager;
  let workspaceDir;
  let containersToCleanup = [];

  beforeAll(() => {
    manager = new IsolatedWorkspaceManager();
    // Create a real temp directory on host
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
  });

  afterAll(async () => {
    // Cleanup containers
    for (const container of containersToCleanup) {
      try {
        await container.stop();
      } catch (e) {
        // Ignore
      }
    }
    // Cleanup workspace dir
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  });

  test('should provision Sandbox A (Read-Write) and allow writing files', async () => {
    const sandbox = await manager.createSandboxA({ workspaceDir });
    containersToCleanup.push(sandbox);

    expect(sandbox.id).toBeDefined();

    // Try to write a file inside the container
    const writeResult = await sandbox.exec(['sh', '-c', 'echo "hello rw" > test_rw.txt']);
    expect(writeResult.exitCode).toBe(0);

    // Verify it exists on host
    const hostFilePath = path.join(workspaceDir, 'test_rw.txt');
    expect(fs.existsSync(hostFilePath)).toBe(true);
    expect(fs.readFileSync(hostFilePath, 'utf8').trim()).toBe('hello rw');

    // Read it back inside the container
    const readResult = await sandbox.exec(['cat', 'test_rw.txt']);
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stdout.trim()).toBe('hello rw');
  }, 180000);

  test('should provision Sandbox B (Read-Only) and fail when trying to write files', async () => {
    // Write a file on host first to check if Sandbox B can read it
    fs.writeFileSync(path.join(workspaceDir, 'existing.txt'), 'hello from host');

    const sandbox = await manager.createSandboxB({ workspaceDir });
    containersToCleanup.push(sandbox);

    expect(sandbox.id).toBeDefined();

    // Check reading existing file in B
    const readResult = await sandbox.exec(['cat', 'existing.txt']);
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stdout.trim()).toBe('hello from host');

    // Try to write a file in B (should fail with Read-only file system error)
    const writeResult = await sandbox.exec(['sh', '-c', 'echo "fail" > test_ro.txt']);
    expect(writeResult.exitCode).not.toBe(0);
    expect(writeResult.stderr).toContain('Read-only file system');
  }, 180000);

  test('should demux stdout and stderr correctly', async () => {
    const sandbox = await manager.createSandboxA({ workspaceDir });
    containersToCleanup.push(sandbox);

    const result = await sandbox.exec(['sh', '-c', 'echo "to stdout" && echo "to stderr" >&2']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('to stdout');
    expect(result.stderr.trim()).toBe('to stderr');
  }, 180000);

  test('should handle commands with non-zero exit codes', async () => {
    const sandbox = await manager.createSandboxA({ workspaceDir });
    containersToCleanup.push(sandbox);

    const result = await sandbox.exec(['sh', '-c', 'exit 42']);
    expect(result.exitCode).toBe(42);
  }, 180000);
});
