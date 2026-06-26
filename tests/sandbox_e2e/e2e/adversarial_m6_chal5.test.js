const fs = require('fs');
const path = require('path');
const os = require('os');
const Docker = require('dockerode');
const { IsolatedWorkspaceManager } = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(120000); // 2 minutes timeout

describe('IsolatedWorkspaceManager Tier 5 White-box Adversarial Hardening (Milestone M6 Chal5)', () => {
  let containersToCleanup = [];
  let dirsToCleanup = [];
  const docker = new Docker();

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-m6-chal5-'));
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

  // Gap 1: Mounting subdirectories of sensitive system directories is not restricted
  test('GAP: should reject mounting a subdirectory of a sensitive system directory', async () => {
    const manager = new IsolatedWorkspaceManager();

    // os.tmpdir() is in the sensitive list, but a subdirectory under it is not blocked
    const sensitiveSubdir = path.join(os.tmpdir(), 'sensitive-sub-workspace');
    
    // We expect the manager to reject this because it resides within the sensitive os.tmpdir()
    // This expectation will fail on the current codebase, showing the gap.
    await expect(manager.createSandboxA({
      workspaceDir: sensitiveSubdir
    })).rejects.toThrow(/Sensitive root\/system directory mount blocked/);
  });

  // Gap 2: Python http.server enforcement bypass via runpy module
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

    // Start http.server via runpy module
    await container.exec([
      'sh',
      '-c',
      'nohup python3 -m runpy http.server 8095 --bind 0.0.0.0 >/dev/null 2>&1 &'
    ]);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Try curling the container's external IP from within the container
    const curlExternal = await container.exec(['curl', '-I', `http://${containerIp}:8095`]);
    
    // If the system is hardened, this server should only bind to 127.0.0.1, making the external curl fail.
    // This expectation will fail on the current codebase (curlExternal.exitCode will be 0).
    expect(curlExternal.exitCode).not.toBe(0);
  });

  // Gap 3: Python http.server enforcement bypass via obfuscated -c command string
  test('GAP: should block python3 http.server from binding to 0.0.0.0 via obfuscated command string', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1']
    }));

    const ipResult = await container.exec(['sh', '-c', "ip route | grep src | awk '{print $NF}'"]);
    const containerIp = ipResult.stdout.trim();

    // Start http.server via obfuscated -c string that bypasses the http.server substring check
    await container.exec([
      'sh',
      '-c',
      'nohup python3 -c "import runpy; runpy.run_module(\'http\' + \'.\' + \'server\')" 8096 --bind 0.0.0.0 >/dev/null 2>&1 &'
    ]);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const curlExternal = await container.exec(['curl', '-I', `http://${containerIp}:8096`]);
    
    // External curl should fail if hardened.
    expect(curlExternal.exitCode).not.toBe(0);
  });

  // Gap 4: Python http.server enforcement bypass via running a script from workspace
  test('GAP: should block python3 http.server from binding to 0.0.0.0 via script execution', async () => {
    const workspaceDir = createTempDir();
    
    // Write a python script on the host to the workspace directory
    const pythonScript = `
import http.server
import socketserver
PORT = 8097
Handler = http.server.SimpleHTTPRequestHandler
http.server.test(Handler, port=PORT, bind="0.0.0.0")
`;
    fs.writeFileSync(path.join(workspaceDir, 'server.py'), pythonScript);

    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1']
    }));

    const ipResult = await container.exec(['sh', '-c', "ip route | grep src | awk '{print $NF}'"]);
    const containerIp = ipResult.stdout.trim();

    // Run the python script
    await container.exec([
      'sh',
      '-c',
      'nohup python3 /workspace/server.py >/dev/null 2>&1 &'
    ]);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const curlExternal = await container.exec(['curl', '-I', `http://${containerIp}:8097`]);
    
    // External curl should fail if hardened.
    expect(curlExternal.exitCode).not.toBe(0);
  });

  // Gap 5: Python http.server enforcement bypass via standard input
  test('GAP: should block python3 http.server from binding to 0.0.0.0 via stdin execution', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1']
    }));

    const ipResult = await container.exec(['sh', '-c', "ip route | grep src | awk '{print $NF}'"]);
    const containerIp = ipResult.stdout.trim();

    // Run python3 reading code from stdin
    await container.exec([
      'sh',
      '-c',
      'nohup sh -c \'echo "import http.server; http.server.test(port=8098, bind=\\"0.0.0.0\\")" | python3\' >/dev/null 2>&1 &'
    ]);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const curlExternal = await container.exec(['curl', '-I', `http://${containerIp}:8098`]);
    
    // External curl should fail if hardened.
    expect(curlExternal.exitCode).not.toBe(0);
  });
});
