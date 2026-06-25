const fs = require('fs');
const path = require('path');
const os = require('os');
const Docker = require('dockerode');
const { IsolatedWorkspaceManager } = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(180000); // 3 minutes timeout

describe('Challenger Milestone M4 & M5 Stress and Network Isolation Tests', () => {
  let containersToCleanup = [];
  let dirsToCleanup = [];
  const docker = new Docker();

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-sandbox-'));
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
        // Suppress errors during cleanup so all containers are processed
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

  // --- 1. Network Rules and Domain Resolutions ---
  describe('Network Rules, DNS Resolutions, and Exfiltration Tests', () => {
    test('should allow connection to allowed domain/IP but block other destinations', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      
      // Allow only one specific public DNS IP (1.1.1.1) and one specific domain (github.com)
      const container = registerContainer(await manager.createSandboxA({
        workspaceDir,
        allowList: ['1.1.1.1', 'github.com']
      }));

      // Test allowed IP connection (TCP port 53 / 80 or just raw nc check)
      // Note: 1.1.1.1 supports port 53 (TCP/UDP) and port 80/443
      const allowedIpRes = await container.exec(['nc', '-z', '-w', '3', '1.1.1.1', '53']);
      expect(allowedIpRes.exitCode).toBe(0);

      // Test blocked IP connection
      const blockedIpRes = await container.exec(['nc', '-z', '-w', '3', '8.8.8.8', '53']);
      expect(blockedIpRes.exitCode).not.toBe(0);
    });

    test('should analyze DNS resolution behavior and check for DNS exfiltration risks', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      
      // Sandbox with limited allowList
      const container = registerContainer(await manager.createSandboxA({
        workspaceDir,
        allowList: ['1.1.1.1']
      }));

      // 1. Invalid DNS Query should fail/return error
      const invalidDnsRes = await container.exec(['getent', 'hosts', 'nonexistent.domain.invalid-12345']);
      expect(invalidDnsRes.exitCode).not.toBe(0);

      // 2. DNS query to a non-allowlisted domain (e.g. google.com)
      // Since port 53 is open to host nameservers, DNS lookups themselves succeed!
      // This is a potential data exfiltration vector. Let's verify and log the outcome.
      const queryRes = await container.exec(['getent', 'hosts', 'google.com']);
      
      console.log(`[Challenger Info] DNS resolution for non-allowlisted google.com: exitCode=${queryRes.exitCode}, stdout=${queryRes.stdout.trim()}`);
      
      // 3. Connect to the resolved IP (should fail because IP is blocked)
      const connectRes = await container.exec(['curl', '-I', '--connect-timeout', '3', 'https://google.com']);
      expect(connectRes.exitCode).not.toBe(0);
    });
  });

  // --- 2. Concurrent Sandboxes with Distinct Networks ---
  describe('Concurrency & Scope of Network Isolation', () => {
    test('should enforce strict isolation between concurrently running sandboxes with different allowlists', async () => {
      const manager = new IsolatedWorkspaceManager();
      const dir1 = createTempDir();
      const dir2 = createTempDir();

      // Sandbox 1 allows ONLY 1.1.1.1
      const c1 = registerContainer(await manager.createSandboxA({
        workspaceDir: dir1,
        allowList: ['1.1.1.1']
      }));

      // Sandbox 2 allows ONLY 8.8.8.8
      const c2 = registerContainer(await manager.createSandboxA({
        workspaceDir: dir2,
        allowList: ['8.8.8.8']
      }));

      // Run connectivity checks in parallel
      const [c1_to_1, c1_to_8, c2_to_1, c2_to_8] = await Promise.all([
        c1.exec(['nc', '-z', '-w', '3', '1.1.1.1', '53']),
        c1.exec(['nc', '-z', '-w', '3', '8.8.8.8', '53']),
        c2.exec(['nc', '-z', '-w', '3', '1.1.1.1', '53']),
        c2.exec(['nc', '-z', '-w', '3', '8.8.8.8', '53'])
      ]);

      // Assertions
      expect(c1_to_1.exitCode).toBe(0);      // c1 can reach 1.1.1.1
      expect(c1_to_8.exitCode).not.toBe(0);  // c1 cannot reach 8.8.8.8
      expect(c2_to_1.exitCode).not.toBe(0);  // c2 cannot reach 1.1.1.1
      expect(c2_to_8.exitCode).toBe(0);      // c2 can reach 8.8.8.8
    });
  });

  // --- 3. Filesystem Isolation in Sandbox B ---
  describe('Sandbox B Filesystem Security & Traversal Controls', () => {
    test('should prevent write traversal, enforce read-only mount, and verify tmpfs properties', async () => {
      const workspaceDir = createTempDir();
      fs.writeFileSync(path.join(workspaceDir, 'secret_file.txt'), 'host_val');

      const manager = new IsolatedWorkspaceManager();
      const container = registerContainer(await manager.createSandboxB({ workspaceDir }));

      // 1. Read-only Rootfs and /workspace checks
      const writeRootRes = await container.exec(['sh', '-c', 'echo "test" > /etc/leak.txt']);
      expect(writeRootRes.exitCode).not.toBe(0);
      expect(writeRootRes.stderr).toContain('Read-only file system');

      const writeWorkspaceRes = await container.exec(['sh', '-c', 'echo "test" > /workspace/secret_file.txt']);
      expect(writeWorkspaceRes.exitCode).not.toBe(0);
      expect(writeWorkspaceRes.stderr).toContain('Read-only file system');

      // 2. Tmpfs write succeeds
      const writeTmpRes = await container.exec(['sh', '-c', 'echo "temp_data" > /tmp/tmp_val.txt && cat /tmp/tmp_val.txt']);
      expect(writeTmpRes.exitCode).toBe(0);
      expect(writeTmpRes.stdout.trim()).toBe('temp_data');

      // 3. Verify /tmp does NOT leak to host filesystem
      expect(fs.existsSync(path.join(workspaceDir, 'tmp_val.txt'))).toBe(false);

      // 4. Try traversing via /workspace/../etc or /workspace/../tmp
      const traversalRes = await container.exec(['sh', '-c', 'echo "hack" > /workspace/../etc/passwd']);
      expect(traversalRes.exitCode).not.toBe(0);

      // 5. Verify docker socket is not accessible to prevent escape
      const dockerSocketRes = await container.exec(['ls', '-la', '/var/run/docker.sock']);
      expect(dockerSocketRes.exitCode).not.toBe(0);
    });
  });

  // --- 4. Cleanup Under Heavy Load ---
  describe('Heavy Load & Lifecycle Cleanup Tests', () => {
    test('should successfully clean up all docker containers and resources under high concurrency load', async () => {
      const manager = new IsolatedWorkspaceManager();
      const numContainers = 8;
      const dirs = Array.from({ length: numContainers }, () => createTempDir());

      // 1. Provision concurrently
      const createPromises = dirs.map(dir => manager.createSandboxA({ workspaceDir: dir }));
      const sandboxes = await Promise.all(createPromises);
      
      const containerIds = sandboxes.map(s => s.id);
      
      // Verify they are all running in Docker
      const inspectPromises = containerIds.map(async (id) => {
        const c = docker.getContainer(id);
        const data = await c.inspect();
        expect(data.State.Running).toBe(true);
      });
      await Promise.all(inspectPromises);

      // 2. Stop and remove concurrently
      const stopPromises = sandboxes.map(s => s.stop());
      await Promise.all(stopPromises);

      // 3. Verify all are completely removed and cannot be inspected
      const verifyPromises = containerIds.map(async (id) => {
        const c = docker.getContainer(id);
        await expect(c.inspect()).rejects.toThrow();
      });
      await Promise.all(verifyPromises);
    });
  });
});
