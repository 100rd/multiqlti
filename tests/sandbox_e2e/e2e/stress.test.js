const fs = require('fs');
const path = require('path');
const os = require('os');
const { IsolatedWorkspaceManager } = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(120000); // 2 minutes timeout for stress tests

describe('IsolatedWorkspaceManager Stress and Security Tests', () => {
  let containersToCleanup = [];
  let dirsToCleanup = [];

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-stress-'));
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

  // Task 1: Concurrency safety
  test('should handle multiple sandbox creations concurrently without collisions', async () => {
    const manager = new IsolatedWorkspaceManager();
    const count = 10;
    const dirs = Array.from({ length: count }, () => createTempDir());
    
    // Create Sandbox A & B concurrently
    const promises = dirs.map((dir, idx) => {
      if (idx % 2 === 0) {
        return manager.createSandboxA({ workspaceDir: dir });
      } else {
        return manager.createSandboxB({ workspaceDir: dir });
      }
    });

    const sandboxes = await Promise.all(promises);
    sandboxes.forEach(s => registerContainer(s));

    // Execute commands in parallel in all of them
    const execPromises = sandboxes.map((s, idx) => {
      if (idx % 2 === 0) {
        return s.exec(['sh', '-c', `echo "concurrency_${idx}" > /workspace/file.txt && cat /workspace/file.txt`]);
      } else {
        return s.exec(['sh', '-c', 'echo "hello from read-only" && ls -la /workspace']);
      }
    });

    const results = await Promise.all(execPromises);
    results.forEach((res, idx) => {
      expect(res.exitCode).toBe(0);
      if (idx % 2 === 0) {
        expect(res.stdout.trim()).toBe(`concurrency_${idx}`);
      } else {
        expect(res.stdout).toContain('hello from read-only');
      }
    });
  });

  // Task 1: Running large files
  test('should handle large file reads and writes in Sandbox A', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    // Write 50MB of data to a file inside the container
    const writeResult = await container.exec(['dd', 'if=/dev/zero', 'of=/workspace/large.bin', 'bs=1M', 'count=50']);
    expect(writeResult.exitCode).toBe(0);

    // Verify it exists on host and has the right size
    const hostPath = path.join(workspaceDir, 'large.bin');
    expect(fs.existsSync(hostPath)).toBe(true);
    expect(fs.statSync(hostPath).size).toBe(50 * 1024 * 1024);

    // Read the file inside the container
    const readResult = await container.exec(['wc', '-c', '/workspace/large.bin']);
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stdout.trim()).toContain('52428800');
  });

  // Task 1: Extremely long commands / arguments
  test('should handle commands with extremely large arguments', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    // Create an extremely large command array (2000 elements)
    const largeArgs = Array.from({ length: 2000 }, (_, idx) => `arg_${idx}`);
    const result = await container.exec(['echo', ...largeArgs]);
    
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('arg_1999');
  });

  // Task 1: Commands that write to stdout/stderr very fast
  test('should handle high-volume and high-speed stdout/stderr output without OOM or truncation', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    // Print 50,000 lines of stdout
    const result = await container.exec(['sh', '-c', 'seq 1 50000']);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines.length).toBe(50000);
    expect(lines[49999]).toBe('50000');
  });

  // Task 1: Nested directories
  test('should handle extremely deep nested directories in Sandbox A', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    // Create a 40-level deep nested directory structure
    const levels = Array.from({ length: 40 }, (_, idx) => `dir_${idx}`).join('/');
    const fullPath = `/workspace/${levels}`;
    
    const mkdirResult = await container.exec(['mkdir', '-p', fullPath]);
    expect(mkdirResult.exitCode).toBe(0);
    
    const writeResult = await container.exec(['sh', '-c', `echo "nested_content" > ${fullPath}/file.txt`]);
    expect(writeResult.exitCode).toBe(0);
    
    const readResult = await container.exec(['cat', `${fullPath}/file.txt`]);
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stdout.trim()).toBe('nested_content');
    
    // Verify it exists on host
    const hostPath = path.join(workspaceDir, levels, 'file.txt');
    expect(fs.existsSync(hostPath)).toBe(true);
    expect(fs.readFileSync(hostPath, 'utf8').trim()).toBe('nested_content');
  });

  // Task 3: Sandbox B (Read-Only) bypass restrictions verification
  test('should block Sandbox B (Read-Only) from bypassing write restrictions via various attack vectors', async () => {
    const workspaceDir = createTempDir();
    // Write an initial file on host
    fs.writeFileSync(path.join(workspaceDir, 'initial.txt'), 'host_data');
    
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    // Vector 1: Attempting to remount the workspace as Read-Write
    const remountRes1 = await container.exec(['mount', '-o', 'remount,rw', '/workspace']);
    expect(remountRes1.exitCode).not.toBe(0);
    
    // Vector 2: Attempting to remount root as Read-Write and writing
    const remountRes2 = await container.exec(['mount', '-o', 'remount,rw', '/']);
    // Even if remounting root succeeds/fails, writing to /workspace must fail
    const writeRes = await container.exec(['sh', '-c', 'echo "bypass" > /workspace/initial.txt']);
    expect(writeRes.exitCode).not.toBe(0);
    expect(fs.readFileSync(path.join(workspaceDir, 'initial.txt'), 'utf8').trim()).toBe('host_data');
    
    // Vector 3: chmod to change permissions of /workspace or initial.txt
    const chmodRes1 = await container.exec(['chmod', '777', '/workspace']);
    expect(chmodRes1.exitCode).not.toBe(0);
    
    const chmodRes2 = await container.exec(['chmod', '777', '/workspace/initial.txt']);
    expect(chmodRes2.exitCode).not.toBe(0);
    
    // Vector 4: Attempt hard link to write through /tmp
    const hardlinkRes = await container.exec(['ln', '/workspace/initial.txt', '/tmp/initial_link.txt']);
    if (hardlinkRes.exitCode === 0) {
      const writeLinkRes = await container.exec(['sh', '-c', 'echo "link_bypass" > /tmp/initial_link.txt']);
      expect(writeLinkRes.exitCode).not.toBe(0);
    }
    expect(fs.readFileSync(path.join(workspaceDir, 'initial.txt'), 'utf8').trim()).toBe('host_data');
    
    // Vector 5: Attempt symlink in /tmp pointing to /workspace/initial.txt and writing to the symlink
    const symlinkRes = await container.exec(['ln', '-s', '/workspace/initial.txt', '/tmp/sym_link.txt']);
    expect(symlinkRes.exitCode).toBe(0);
    const writeSymRes = await container.exec(['sh', '-c', 'echo "sym_bypass" > /tmp/sym_link.txt']);
    expect(writeSymRes.exitCode).not.toBe(0);
    expect(writeSymRes.stderr).toContain('Read-only file system');
    expect(fs.readFileSync(path.join(workspaceDir, 'initial.txt'), 'utf8').trim()).toBe('host_data');
    
    // Vector 6: Attempting to write via nested directory structure created on host
    const nestedDir = path.join(workspaceDir, 'nested', 'sub');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, 'file.txt'), 'nested_host_data');
    
    const writeNestedRes = await container.exec(['sh', '-c', 'echo "nested_bypass" > /workspace/nested/sub/file.txt']);
    expect(writeNestedRes.exitCode).not.toBe(0);
    expect(writeNestedRes.stderr).toContain('Read-only file system');
    expect(fs.readFileSync(path.join(nestedDir, 'file.txt'), 'utf8').trim()).toBe('nested_host_data');
  });
});
