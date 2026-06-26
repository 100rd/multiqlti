const fs = require('fs');
const path = require('path');
const os = require('os');
const Docker = require('dockerode');
const { IsolatedWorkspaceManager } = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(180000); // 3 minutes timeout for this extensive suite

describe('IsolatedWorkspaceManager Challenger M4 & M5 Stress and Adversarial Suite', () => {
  let containersToCleanup = [];
  let dirsToCleanup = [];
  const docker = new Docker();

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-challenger-'));
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
    // Stop all registered containers concurrently
    await Promise.all(
      containersToCleanup.map(async (container) => {
        try {
          await container.stop();
        } catch (e) {
          // Ignore cleanup errors
        }
      })
    );
    containersToCleanup = [];

    // Delete all temporary directories
    for (const dir of dirsToCleanup) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    dirsToCleanup = [];
  });

  // 1. Network Rules, Domain Name Resolutions, and Invalid DNS Queries
  test('should verify robust DNS queries, invalid DNS inputs, and network blocking', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(
      await manager.createSandboxA({
        workspaceDir,
        allowList: ['api.github.com', '1.1.1.1']
      })
    );

    // Verify allowed domain resolves and connects
    const resolveAllowed = await container.exec(['nslookup', 'api.github.com']);
    expect(resolveAllowed.exitCode).toBe(0);
    const connAllowed = await container.exec(['curl', '-I', '--connect-timeout', '3', 'https://api.github.com']);
    expect(connAllowed.exitCode).toBe(0);

    // Verify allowed IP connects
    const connIpAllowed = await container.exec(['nc', '-z', '-w', '3', '1.1.1.1', '53']);
    expect(connIpAllowed.exitCode).toBe(0);

    // Verify blocked IP ping fails
    const pingBlocked = await container.exec(['ping', '-c', '1', '-W', '2', '8.8.8.8']);
    expect(pingBlocked.exitCode).not.toBe(0);

    // Verify connection to non-allowlisted domain (google.com) fails
    const connBlockedDomain = await container.exec(['curl', '-I', '--connect-timeout', '3', 'https://google.com']);
    expect(connBlockedDomain.exitCode).not.toBe(0);

    // Verify invalid DNS queries handle gracefully (NXDOMAIN or error, but no container or command crash)
    const invalidDns1 = await container.exec(['nslookup', 'invaliddomain!@#$%.invalid']);
    expect(invalidDns1.exitCode).not.toBe(0);

    // Extremely long DNS query (boundary check)
    const extremelyLongDomain = 'a'.repeat(200) + '.com';
    const invalidDns2 = await container.exec(['nslookup', extremelyLongDomain]);
    expect(invalidDns2.exitCode).not.toBe(0);

    // DNS query with spaces and shell inject characters
    const invalidDns3 = await container.exec(['nslookup', 'google.com; echo "hacked"']);
    expect(invalidDns3.exitCode).not.toBe(0);
    const invalidDns3Lines = invalidDns3.stdout.split('\n').map(l => l.trim());
    expect(invalidDns3Lines).not.toContain('hacked');

    // Verify DNS query of a non-allowlisted domain (google.com)
    // Since port 53 is open to DNS servers to resolve allowlisted domains, DNS queries to non-allowlisted
    // domains also resolve, but TCP/UDP traffic to their resolved IPs is blocked.
    const dnsQueryBlockedDomain = await container.exec(['nslookup', 'google.com']);
    expect(dnsQueryBlockedDomain.exitCode).toBe(0); // DNS resolution succeeds
  });

  // 2. Concurrent Sandbox Creations with Distinct Networks
  test('should enforce strict separation of network rules for concurrent sandboxes', async () => {
    const manager = new IsolatedWorkspaceManager();
    const workspace1 = createTempDir();
    const workspace2 = createTempDir();
    const workspace3 = createTempDir();
    const workspace4 = createTempDir();

    // Provision concurrently
    const [c1, c2, c3, c4] = await Promise.all([
      manager.createSandboxA({ workspaceDir: workspace1, allowList: ['1.1.1.1'] }),
      manager.createSandboxA({ workspaceDir: workspace2, allowList: ['8.8.8.8'] }),
      manager.createSandboxA({ workspaceDir: workspace3, allowList: ['api.github.com'] }),
      manager.createSandboxA({ workspaceDir: workspace4 }) // None network mode
    ]);

    registerContainer(c1);
    registerContainer(c2);
    registerContainer(c3);
    registerContainer(c4);

    // Run parallel network verification checks
    const checks = await Promise.all([
      // c1: 1.1.1.1 ok, 8.8.8.8 fail, github fail
      c1.exec(['nc', '-z', '-w', '3', '1.1.1.1', '53']),
      c1.exec(['nc', '-z', '-w', '3', '8.8.8.8', '53']),
      c1.exec(['curl', '-I', '--connect-timeout', '3', 'https://api.github.com']),

      // c2: 8.8.8.8 ok, 1.1.1.1 fail, github fail
      c2.exec(['nc', '-z', '-w', '3', '8.8.8.8', '53']),
      c2.exec(['nc', '-z', '-w', '3', '1.1.1.1', '53']),
      c2.exec(['curl', '-I', '--connect-timeout', '3', 'https://api.github.com']),

      // c3: github ok, 1.1.1.1 fail, 8.8.8.8 fail
      c3.exec(['curl', '-I', '--connect-timeout', '3', 'https://api.github.com']),
      c3.exec(['nc', '-z', '-w', '3', '1.1.1.1', '53']),
      c3.exec(['nc', '-z', '-w', '3', '8.8.8.8', '53']),

      // c4: all fail (no network)
      c4.exec(['nc', '-z', '-w', '3', '1.1.1.1', '53']),
      c4.exec(['curl', '-I', '--connect-timeout', '3', 'https://api.github.com'])
    ]);

    // c1 results
    expect(checks[0].exitCode).toBe(0);
    expect(checks[1].exitCode).not.toBe(0);
    expect(checks[2].exitCode).not.toBe(0);

    // c2 results
    expect(checks[3].exitCode).toBe(0);
    expect(checks[4].exitCode).not.toBe(0);
    expect(checks[5].exitCode).not.toBe(0);

    // c3 results
    expect(checks[6].exitCode).toBe(0);
    expect(checks[7].exitCode).not.toBe(0);
    expect(checks[8].exitCode).not.toBe(0);

    // c4 results
    expect(checks[9].exitCode).not.toBe(0);
    expect(checks[10].exitCode).not.toBe(0);
  });

  // 3. Sandbox B (Read-Only) Rootfs and Tmpfs filesystem isolation & no traversal
  test('should strictly isolate the filesystem in Sandbox B and prevent traversal/escapes', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));

    // Verify container root filesystem is read-only
    const writeRoot = await container.exec(['touch', '/root_file.txt']);
    expect(writeRoot.exitCode).not.toBe(0);
    expect(writeRoot.stderr).toContain('Read-only file system');

    const writeEtc = await container.exec(['touch', '/etc/test.txt']);
    expect(writeEtc.exitCode).not.toBe(0);
    expect(writeEtc.stderr).toContain('Read-only file system');

    const writeUsr = await container.exec(['touch', '/usr/bin/test_exec']);
    expect(writeUsr.exitCode).not.toBe(0);
    expect(writeUsr.stderr).toContain('Read-only file system');

    // Verify /tmp is writable (tmpfs)
    const writeTmp = await container.exec(['sh', '-c', 'echo "hello tmp" > /tmp/tmp_file.txt && cat /tmp/tmp_file.txt']);
    expect(writeTmp.exitCode).toBe(0);
    expect(writeTmp.stdout.trim()).toBe('hello tmp');

    // Verify workspace is read-only
    const writeWorkspace = await container.exec(['touch', '/workspace/new.txt']);
    expect(writeWorkspace.exitCode).not.toBe(0);
    expect(writeWorkspace.stderr).toContain('Read-only file system');

    // Verify traversal inside container cannot escape to write
    const writeTraversal1 = await container.exec(['touch', '/workspace/../etc/hosts']);
    expect(writeTraversal1.exitCode).not.toBe(0);

    const writeTraversal2 = await container.exec(['touch', '/workspace/../../tmp/outside.txt']);
    // Even if resolved to /tmp/outside.txt, let's verify if we can write to it or if it fails
    // Note: /tmp/outside.txt is writable because /tmp is writable.
    // However, let's verify that we cannot escape to access or modify host files.
    // We try to find host files. E.g. host user directory '/Users/lord' or host temp files.
    const accessHost = await container.exec(['ls', '/Users/lord']);
    expect(accessHost.exitCode).not.toBe(0); // Should fail (no such file or directory)
  });

  // 4. Container cleanup under heavy load
  test('should handle container cleanup under heavy load without leaking resources', async () => {
    const manager = new IsolatedWorkspaceManager();
    const count = 15;
    const workspaces = Array.from({ length: count }, () => createTempDir());

    // Create 15 sandboxes in parallel
    const creationPromises = workspaces.map((dir, idx) => {
      if (idx % 3 === 0) {
        return manager.createSandboxA({ workspaceDir: dir, allowList: ['1.1.1.1'] });
      } else if (idx % 3 === 1) {
        return manager.createSandboxB({ workspaceDir: dir });
      } else {
        return manager.createSandboxA({ workspaceDir: dir });
      }
    });

    const activeContainers = await Promise.all(creationPromises);
    activeContainers.forEach(c => registerContainer(c));

    // Verify they are all running
    const inspectPromises = activeContainers.map(async (c) => {
      const inspectData = await docker.getContainer(c.id).inspect();
      expect(inspectData.State.Running).toBe(true);
    });
    await Promise.all(inspectPromises);

    // Stop them all concurrently (heavy load cleanup)
    const stopPromises = activeContainers.map(c => c.stop());
    await Promise.all(stopPromises);

    // Verify that every single container is removed from Docker
    const checkPromises = activeContainers.map(async (c) => {
      await expect(docker.getContainer(c.id).inspect()).rejects.toThrow();
    });
    await Promise.all(checkPromises);

    // Clear registered containers array since they are already stopped
    containersToCleanup = [];
  });
});
