const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');
const Docker = require('dockerode');
const { IsolatedWorkspaceManager } = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(60000); // 1 minute timeout per test

describe('IsolatedWorkspaceManager Phase 2 White-box Adversarial Hardening Suite', () => {
  let containersToCleanup = [];
  let dirsToCleanup = [];
  const docker = new Docker();

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-adversarial-m6-'));
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

    // Restore mocked dns if any
    jest.restoreAllMocks();
  });

  // 1. Network Allowlist Input Validation & Rejection
  describe('Network Allowlist Validation Gaps', () => {
    test('should reject non-array and non-string allowList inputs', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();

      await expect(manager.createSandboxA({ workspaceDir, allowList: 'not-an-array' }))
        .rejects.toThrow('allowList must be an array of strings');
      await expect(manager.createSandboxA({ workspaceDir, allowList: {} }))
        .rejects.toThrow('allowList must be an array of strings');
      await expect(manager.createSandboxA({ workspaceDir, allowList: [123] }))
        .rejects.toThrow('allowList entries must be strings');
      await expect(manager.createSandboxA({ workspaceDir, allowList: [null] }))
        .rejects.toThrow('allowList entries must be strings');
    });

    test('should reject command injection sequences in allowList', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      const injectDomains = [
        'example.com; rm -rf /',
        'example.com && touch file',
        'example.com\nsh',
        'example.com|sh',
        '-j ACCEPT',
        '--',
      ];
      for (const entry of injectDomains) {
        await expect(manager.createSandboxA({ workspaceDir, allowList: [entry] }))
          .rejects.toThrow(/Invalid allowList entry/);
      }
    });

    test('should reject invalid formats like schemes and paths', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      const invalidFormats = [
        'https://example.com',
        'example.com/path',
        'example.com ',
        ' example.com',
        'example..com',
        '.example.com',
        '1.2.3.4.5',
        '',
      ];
      for (const entry of invalidFormats) {
        await expect(manager.createSandboxA({ workspaceDir, allowList: [entry] }))
          .rejects.toThrow(/Invalid allowList entry/);
      }
    });

    // This test highlights the gap where invalid IPs (e.g. 999.999.999.999) are NOT rejected by the regex
    test('GAP: should reject invalid IP addresses (e.g. octets > 255)', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      
      // 999.999.999.999 matches ipRegex because it only checks 1-3 digits, not value <= 255.
      // Therefore, this expectation WILL FAIL (it resolves instead of rejecting).
      await expect(manager.createSandboxA({ workspaceDir, allowList: ['999.999.999.999'] }))
        .rejects.toThrow(/Invalid allowList entry/);
    });

    // This test highlights the gap where label lengths of 63 characters are accepted, whereas maximum label size in DNS is 63.
    // Actually, domainRegex allows labels up to 63 chars (1 + 61 + 1), which is correct for DNS, but let's test if label of 64 chars is rejected.
    test('should reject domains with labels exceeding 63 characters', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      const longLabel = 'a'.repeat(64) + '.com'; // 64 characters label
      await expect(manager.createSandboxA({ workspaceDir, allowList: [longLabel] }))
        .rejects.toThrow(/Invalid allowList entry/);
    });
  });

  // 2. DNS Resolution Command Injection Vulnerability (White-box verification)
  describe('DNS Resolution Hardening', () => {
    test('GAP: should reject resolved IPs containing shell command injection', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();

      // Spy on dns.lookup to return a command injection payload as the resolved IP address
      const injectionPayload = '1.1.1.1 && touch /tmp/m6_injected.txt && echo 1.1.1.1';
      jest.spyOn(dns, 'lookup').mockImplementation((hostname, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        cb(null, [{ address: injectionPayload, family: 4 }]);
      });

      // Start the sandbox. If command injection is vulnerable, /tmp/m6_injected.txt will be created.
      const container = registerContainer(await manager.createSandboxA({
        workspaceDir,
        allowList: ['github.com']
      }));

      // Check if the injected file was created in the container root filesystem
      const checkRes = await container.exec(['ls', '/tmp/m6_injected.txt']);
      
      if (checkRes.exitCode === 0) {
        console.warn('⚠️ WARNING: Command injection vulnerability verified! File was created via injected IP.');
      }
      
      // If the system is hardened, the command execution should fail or the file should not be created.
      // This expectation will fail on the current codebase, showing the gap.
      expect(checkRes.exitCode).not.toBe(0);
    });
  });

  // 3. Python http.server Binding Bypass
  describe('Python Wrapper Binding Policy', () => {
    test('GAP: should block python3 http.server from binding to 0.0.0.0 via explicit arguments', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      const container = registerContainer(await manager.createSandboxA({ workspaceDir, allowList: ['1.1.1.1'] }));

      // Get container IP address inside the bridge network
      const ipResult = await container.exec(['sh', '-c', "ip route | grep src | awk '{print $NF}'"]);
      const containerIp = ipResult.stdout.trim();

      // Bypass via explicit -b 0.0.0.0
      await container.exec(['sh', '-c', 'nohup python3 -m http.server 8092 -b 0.0.0.0 >/dev/null 2>&1 &']);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const curlExternalB = await container.exec(['curl', '-I', `http://${containerIp}:8092`]);
      if (curlExternalB.exitCode === 0) {
        console.warn('⚠️ WARNING: Python http.server binding bypass via "-b 0.0.0.0" verified!');
      }
      
      // If hardened, external access must fail (exitCode !== 0) because the server should bind only to 127.0.0.1.
      // This expectation will fail on the current codebase.
      expect(curlExternalB.exitCode).not.toBe(0);
    });

    test('GAP: should block python3 http.server from binding to 0.0.0.0 via python -c execution', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      const container = registerContainer(await manager.createSandboxA({ workspaceDir, allowList: ['1.1.1.1'] }));

      // Get container IP address inside the bridge network
      const ipResult = await container.exec(['sh', '-c', "ip route | grep src | awk '{print $NF}'"]);
      const containerIp = ipResult.stdout.trim();

      // Bypass via python3 -c execution
      await container.exec([
        'sh',
        '-c',
        'nohup python3 -c "import http.server; http.server.test(http.server.SimpleHTTPRequestHandler, port=8093, bind=\'0.0.0.0\')" >/dev/null 2>&1 &'
      ]);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const curlExternalC = await container.exec(['curl', '-I', `http://${containerIp}:8093`]);
      if (curlExternalC.exitCode === 0) {
        console.warn('⚠️ WARNING: Python http.server binding bypass via -c import verified!');
      }

      // If hardened, external access must fail (exitCode !== 0).
      // This expectation will fail on the current codebase.
      expect(curlExternalC.exitCode).not.toBe(0);
    });
  });

  // 4. SQLite Dot-Command Execution Check
  describe('SQLite Shell Command Execution', () => {
    test('should verify if dot-commands can execute shell commands through sqlite3', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      const container = registerContainer(await manager.createSandboxA({ workspaceDir }));

      const res = await container.exec(['sqlite3', 'test.db', '.shell echo sqlite_shell_executed']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('sqlite_shell_executed');
    });
  });

  // 5. File-as-Workspace Validation
  describe('Workspace Directory Path Validation', () => {
    test('should reject a file path as workspaceDir', async () => {
      const tempDir = createTempDir();
      const filePath = path.join(tempDir, 'file.txt');
      fs.writeFileSync(filePath, 'dummy');

      const manager = new IsolatedWorkspaceManager();
      // Should throw an error since mkdirSync will fail
      await expect(manager.createSandboxA({ workspaceDir: filePath }))
        .rejects.toThrow();
    });
  });

  // 6. Double stop and post-stop execution handling
  describe('Sandbox Lifecycle Edge Cases', () => {
    test('should handle double stop and fail exec calls on stopped container', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      const container = await manager.createSandboxA({ workspaceDir });

      // Stop once
      await expect(container.stop()).resolves.not.toThrow();

      // Stop twice (should not throw, should handle gracefully)
      await expect(container.stop()).resolves.not.toThrow();

      // Exec after stop should fail/reject
      await expect(container.exec(['ls'])).rejects.toThrow();
    });
  });
});
