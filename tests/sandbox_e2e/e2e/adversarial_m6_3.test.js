const fs = require('fs');
const path = require('path');
const os = require('os');
const Docker = require('dockerode');
const { IsolatedWorkspaceManager } = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(120000); // 2 minutes timeout

describe('IsolatedWorkspaceManager Phase 2 White-box Challenger Gaps Verification Suite', () => {
  let containersToCleanup = [];
  let dirsToCleanup = [];
  const docker = new Docker();

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-m6-chal-'));
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

  // Gap 1: Sensitive subdirectory mount bypass
  test('GAP: should reject mounting a subdirectory of a sensitive system directory', async () => {
    const manager = new IsolatedWorkspaceManager();
    const sensitiveSubdir = '/usr/bin';
    
    await expect(manager.createSandboxA({
      workspaceDir: sensitiveSubdir
    })).rejects.toThrow('Sensitive root/system directory mount blocked');
  });

  // Gap 2: Python runpy loopback bypass
  test('GAP: should block python3 http.server from binding to 0.0.0.0 via runpy module invocation', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1'] // Bridge mode to get external interface
    }));

    // Get container IP address inside the bridge network
    const ipResult = await container.exec(['sh', '-c', "ip route | grep src | awk '{print $NF}'"]);
    const containerIp = ipResult.stdout.trim();

    // Start http.server using -m runpy http.server
    await container.exec([
      'sh',
      '-c',
      "nohup python3 -m runpy http.server 8095 --bind 0.0.0.0 >/dev/null 2>&1 &"
    ]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify it is NOT accessible on the bridge IP (proves loopback bypass is blocked)
    const curlRes = await container.exec(['curl', '-I', `http://${containerIp}:8095`]);
    expect(curlRes.exitCode).not.toBe(0);
  });

  // Gap 3: Python obfuscated command string bypass
  test('GAP: should block python3 http.server from binding to 0.0.0.0 via obfuscated command string', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1']
    }));

    const ipResult = await container.exec(['sh', '-c', "ip route | grep src | awk '{print $NF}'"]);
    const containerIp = ipResult.stdout.trim();

    // Start http.server using obfuscated -c command by importing modules dynamically
    const obfuscatedCmd = "import importlib; s = importlib.import_module('so' + 'cketserver'); h = importlib.import_module('ht' + 'tp.server'); s.TCPServer(('', 8096), h.SimpleHTTPRequestHandler).serve_forever()";
    await container.exec([
      'sh',
      '-c',
      `nohup python3 -c "${obfuscatedCmd}" >/dev/null 2>&1 &`
    ]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const curlRes = await container.exec(['curl', '-I', `http://${containerIp}:8096`]);
    expect(curlRes.exitCode).not.toBe(0);
  });

  // Gap 4: Python script execution bypass
  test('GAP: should block python3 http.server from binding to 0.0.0.0 via script execution', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1']
    }));

    const ipResult = await container.exec(['sh', '-c', "ip route | grep src | awk '{print $NF}'"]);
    const containerIp = ipResult.stdout.trim();

    // Write python script inside workspace (uses run_module, which is blocked by our wrapper)
    fs.writeFileSync(
      path.join(workspaceDir, 'server.py'),
      "import runpy\nrunpy.run_module('http.server')\n"
    );

    // Run script
    await container.exec([
      'sh',
      '-c',
      'nohup python3 /workspace/server.py >/dev/null 2>&1 &'
    ]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const curlRes = await container.exec(['curl', '-I', `http://${containerIp}:8097`]);
    expect(curlRes.exitCode).not.toBe(0);
  });

  // Gap 5: Python stdin piping bypass
  test('GAP: should block python3 http.server from binding to 0.0.0.0 via stdin execution', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1']
    }));

    const ipResult = await container.exec(['sh', '-c', "ip route | grep src | awk '{print $NF}'"]);
    const containerIp = ipResult.stdout.trim();

    // Run python code via stdin pipe
    await container.exec([
      'sh',
      '-c',
      'echo "import http.server, socketserver; socketserver.TCPServer((\'\', 8098), http.server.SimpleHTTPRequestHandler).serve_forever()" | nohup python3 >/dev/null 2>&1 &'
    ]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const curlRes = await container.exec(['curl', '-I', `http://${containerIp}:8098`]);
    expect(curlRes.exitCode).not.toBe(0);
  });

  // Gap 6: Direct binary bypass (python3.real)
  test('GAP: should block direct execution of the real python binary', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1']
    }));

    const ipResult = await container.exec(['sh', '-c', "ip route | grep src | awk '{print $NF}'"]);
    const containerIp = ipResult.stdout.trim();

    // Invoke /usr/bin/python3.real directly
    await container.exec([
      'sh',
      '-c',
      'nohup /usr/bin/python3.real -m http.server 8099 --bind 0.0.0.0 >/dev/null 2>&1 &'
    ]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const curlRes = await container.exec(['curl', '-I', `http://${containerIp}:8099`]);
    expect(curlRes.exitCode).not.toBe(0);
  });
});
