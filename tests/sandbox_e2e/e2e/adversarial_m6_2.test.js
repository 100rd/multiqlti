const fs = require('fs');
const path = require('path');
const os = require('os');
const Docker = require('dockerode');
const dns = require('dns');
const { IsolatedWorkspaceManager } = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(120000); // 2 minutes timeout

describe('IsolatedWorkspaceManager Phase 2 White-box Adversarial Hardening (Milestone M6)', () => {
  let containersToCleanup = [];
  let dirsToCleanup = [];
  const docker = new Docker();

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-m6-2-'));
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

  // Gap 1: Python http.server enforcement bypass via -mhttp.server (no space)
  test('should verify python http.server enforcement bypass via -mhttp.server syntax', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1'] // Put in bridge mode to get external interface
    }));

    // 1. Standard syntax: python3 -m http.server 8000
    // This should force localhost binding (127.0.0.1:8000)
    const stdRes = await container.exec([
      'sh',
      '-c',
      'python3 -m http.server 8000 & PID=$!; for i in $(seq 1 20); do netstat -an | grep 8000 && break; sleep 0.5; done; kill $PID'
    ]);
    expect(stdRes.exitCode).toBe(0);
    expect(stdRes.stdout).toContain('127.0.0.1:8000');
    expect(stdRes.stdout).not.toContain('0.0.0.0:8000');

    // 2. Bypassed syntax: python3 -mhttp.server 8080 (no space)
    // This should now be normalized and force localhost binding (127.0.0.1:8080)
    const bypassRes = await container.exec([
      'sh',
      '-c',
      'python3 -mhttp.server 8080 & PID=$!; for i in $(seq 1 20); do netstat -an | grep 8080 && break; sleep 0.5; done; kill $PID'
    ]);
    expect(bypassRes.exitCode).toBe(0);
    expect(bypassRes.stdout).toContain('127.0.0.1:8080');
    expect(bypassRes.stdout).not.toContain('0.0.0.0:8080');
  });

  // Gap 2: Domain resolving to IPv6 causes sandbox creation failure due to iptables incompatibility
  test('should show that domain resolving to IPv6 causes sandbox creation failure', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();

    // Spy on dns.lookup to simulate a domain resolving to IPv6
    const originalLookup = dns.lookup;
    dns.lookup = (domain, options, callback) => {
      if (domain === 'ipv6-only.example.com') {
        const cb = typeof options === 'function' ? options : callback;
        cb(null, [{ address: '2001:4860:4860::8888', family: 6 }]);
        return;
      }
      originalLookup(domain, options, callback);
    };

    try {
      // Creation should succeed (resolve) because IPv6 is filtered out and no invalid iptables rule is generated
      const container = registerContainer(await manager.createSandboxA({
        workspaceDir,
        allowList: ['ipv6-only.example.com']
      }));
      expect(container).toBeDefined();
    } finally {
      dns.lookup = originalLookup;
    }
  });

  // Gap 3: Host Directory Mount / Path Traversal vulnerability
  test('should show that workspaceDir is not restricted, allowing mounting of host parent or sensitive directories', async () => {
    const parentDir = createTempDir();
    const intendedWorkspace = path.join(parentDir, 'workspace');
    fs.mkdirSync(intendedWorkspace, { recursive: true });

    // Create a host file OUTSIDE the intended workspace directory
    const secretHostFile = path.join(parentDir, 'secret_host_file.txt');
    fs.writeFileSync(secretHostFile, 'super-secret-host-data');

    const manager = new IsolatedWorkspaceManager();
    
    // We pass a path that goes up to the parent directory containing a literal '..'
    const traversalWorkspaceDir = intendedWorkspace + '/..';
    await expect(manager.createSandboxA({
      workspaceDir: traversalWorkspaceDir
    })).rejects.toThrow();

    // We also verify that mounting a sensitive system directory is rejected
    await expect(manager.createSandboxA({
      workspaceDir: os.tmpdir()
    })).rejects.toThrow();
  });

  // Gap 4: SQLite3 wrapper query alteration
  test('should show sqlite3 wrapper alters queries containing escaped quotes', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));

    // Create a test sqlite DB and table
    const createTableRes = await container.exec([
      'sqlite3',
      '/workspace/test.db',
      'CREATE TABLE items (name TEXT);'
    ]);
    expect(createTableRes.exitCode).toBe(0);

    // We want to insert an item named "item\\" (with a backslash and a quote, or similar)
    // The query is: INSERT INTO items VALUES ('item\\');
    // We will execute the insert, and then query the table.
    const insertRes = await container.exec([
      'sqlite3',
      '/workspace/test.db',
      "INSERT INTO items VALUES ('item\\');"
    ]);
    expect(insertRes.exitCode).toBe(0);

    const queryRes = await container.exec([
      'sqlite3',
      '/workspace/test.db',
      'SELECT name FROM items;'
    ]);
    expect(queryRes.exitCode).toBe(0);
    // It should insert 'item\' (retaining the backslash) because we no longer naive-replace in the wrapper
    expect(queryRes.stdout.trim()).toBe('item\\');
  });
});
