const fs = require('fs');
const path = require('path');
const os = require('os');
const Docker = require('dockerode');
const { IsolatedWorkspaceManager } = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(120000); // 2 minutes timeout

describe('IsolatedWorkspaceManager Tier 5 Adversarial Hardening Suite', () => {
  let containersToCleanup = [];
  let dirsToCleanup = [];
  const docker = new Docker();

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-tier5-'));
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
    // Clean up containers
    await Promise.all(
      containersToCleanup.map(async (container) => {
        try {
          await container.stop();
        } catch (e) {
          // Suppress errors during cleanup
        }
      })
    );
    containersToCleanup = [];

    // Clean up directories
    for (const dir of dirsToCleanup) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        // Suppress errors during cleanup
      }
    }
    dirsToCleanup = [];
  });

  // Gap 1: Python Loopback Bypass via Standard Input (stdin)
  test('GAP 1: should block python http.server loopback bypass via stdin redirection', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1'] // puts in bridge mode to get external interface
    }));

    // Try to run http.server via stdin redirection
    const execRes = await container.exec([
      'sh',
      '-c',
      'echo "import http.server; http.server.test(port=8094)" | python3'
    ]);

    expect(execRes.exitCode).not.toBe(0);
    expect(execRes.stderr).toContain('Security Error');
  });

  // Gap 2: Direct Execution of the Real Python Binary
  test('GAP 2: should redirect bind to 127.0.0.1 via preload library when executing python3.real directly', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1']
    }));

    // Run python3.real directly
    const execRes = await container.exec([
      'sh',
      '-c',
      'python3.real -m http.server 8095 & PID=$!; sleep 2; netstat -an | grep 8095; kill $PID'
    ]);

    expect(execRes.stdout).toContain('127.0.0.1:8095');
    expect(execRes.stdout).not.toContain('0.0.0.0:8095');
    expect(execRes.stdout).not.toContain(':::8095');
  });

  // Gap 3: Host Directory Mount Bypass via macOS /private Directory
  test('GAP 3: should block sensitive directory mount of /private', async () => {
    const manager = new IsolatedWorkspaceManager();
    await expect(
      manager.createSandboxA({
        workspaceDir: '/private'
      })
    ).rejects.toThrow('Sensitive root/system directory mount blocked');
  });

  // Gap 5: Python Wrapper -c Bypass via Dynamic Imports
  test('GAP 5: should block python execution via dynamic imports in command string', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1']
    }));

    // Run http.server using importlib dynamic import
    const execRes = await container.exec([
      'python3',
      '-c',
      'import importlib; importlib.import_module(\'ht\' + \'tp.se\' + \'rver\').test(port=8096)'
    ]);

    expect(execRes.exitCode).not.toBe(0);
    expect(execRes.stderr).toContain('importlib');
  });

  // Gap 7: DNS Spoofing / IP Hijacking (SSRF/Rebinding)
  test('GAP 7: should exclude private IPs resolved from allowList domain names from iptables rules', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    
    const dns = require('dns');
    const util = require('util');
    const originalLookup = dns.lookup;
    
    // Create a mock lookup with a custom promisify symbol to override util.promisify(dns.lookup)
    const mockLookup = (domain, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      cb(null, [{ address: '192.168.1.50', family: 4 }]);
    };
    mockLookup[util.promisify.custom] = async (domain, options) => {
      return [{ address: '192.168.1.50', family: 4 }];
    };
    dns.lookup = mockLookup;

    try {
      const container = registerContainer(await manager.createSandboxA({
        workspaceDir,
        allowList: ['allowed-private-domain.com']
      }));
      
      // Check iptables rules using raw Dockerode as root
      const rawContainer = docker.getContainer(container.id);
      const execInstance = await rawContainer.exec({
        Cmd: ['iptables', '-S', 'OUTPUT'],
        AttachStdout: true,
        AttachStderr: true,
        User: 'root'
      });
      const stream = await execInstance.start({ Detach: false });
      
      let stdoutData = '';
      await new Promise((resolve, reject) => {
        stream.on('data', (chunk) => {
          stdoutData += chunk.toString();
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      expect(stdoutData).not.toContain('-d 192.168.1.50/32 -j ACCEPT');
    } finally {
      dns.lookup = originalLookup;
    }
  });
});
