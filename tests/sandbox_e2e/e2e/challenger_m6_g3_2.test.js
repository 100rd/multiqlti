const fs = require('fs');
const path = require('path');
const os = require('os');
const Docker = require('dockerode');
const { IsolatedWorkspaceManager } = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(120000); // 2 minutes timeout

describe('Challenger M6 Gen3 2 Adversarial Stress and Bypass Tests', () => {
  let containersToCleanup = [];
  let dirsToCleanup = [];
  const docker = new Docker();

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-chal-g3-2-'));
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

  // 1. Python3 Wrapper Bypass via PYTHONPATH
  test('should verify python3 wrapper bypass using PYTHONPATH environment variable is blocked', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));

    // Write a module exploit_m6.py containing blocked keywords (importlib)
    const exploitCode = `import importlib
print("BYPASS_SUCCESS")
`;
    fs.writeFileSync(path.join(workspaceDir, 'exploit_m6.py'), exploitCode);

    // Execute with PYTHONPATH set to /workspace and invoking the module via -m
    // The argument is 'exploit_m6', which does not contain '/' or '.py', bypassing wrapper content checks.
    const res = await container.exec([
      'sh',
      '-c',
      'PYTHONPATH=/workspace python3 -m exploit_m6'
    ]);

    console.log(`[Challenger PYTHONPATH Bypass] exitCode=${res.exitCode}, stdout=${res.stdout.trim()}, stderr=${res.stderr.trim()}`);
    // The wrapper should NOT be bypassed; it should return a non-zero exit code and block the execution
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('Security Error');
    expect(res.stdout).not.toContain('BYPASS_SUCCESS');
  });

  // 2. Sensitive path / subdirectory mount check
  test('should verify that we cannot mount sensitive subdirectories under the user home directory', async () => {
    const manager = new IsolatedWorkspaceManager();

    // os.homedir() is the user's home directory (e.g. /Users/lord on mac)
    // A subdirectory of it like os.homedir() + '/.ssh' is extremely sensitive.
    // The validator should reject this but it does not because /Users is only in exactBlockedList.
    const sensitiveSubdir = path.join(os.homedir(), '.ssh');

    // We expect that the manager blocks creating a sandbox with this path and throws
    // the 'Sensitive root/system directory mount blocked' error.
    let threwMountBlocked = false;
    try {
      await manager.createSandboxA({ workspaceDir: sensitiveSubdir });
    } catch (err) {
      if (err.message.includes('Sensitive root/system directory mount blocked')) {
        threwMountBlocked = true;
      }
    }

    console.log(`[Challenger Mount Check] threwMountBlocked=${threwMountBlocked}`);
    // The validator blocks this, so threwMountBlocked will be true!
    expect(threwMountBlocked).toBe(true);
  });

  // 3. Static binary compilation and execution bypassing bind_shortcut.so
  test('should verify that statically linked binaries bypass bind_shortcut.so', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({ workspaceDir }));

    // Write a C program to bind to 0.0.0.0 and print the bound IP
    const cProgramContent = `
#include <sys/socket.h>
#include <netinet/in.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>

int main() {
    int sockfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sockfd < 0) return 1;
    
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(8092);

    if (bind(sockfd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        return 2;
    }
    
    struct sockaddr_in bound_addr;
    socklen_t len = sizeof(bound_addr);
    if (getsockname(sockfd, (struct sockaddr *)&bound_addr, &len) < 0) {
        return 3;
    }
    
    printf("bound_ip=%d.%d.%d.%d\\n",
           (bound_addr.sin_addr.s_addr >> 0) & 0xFF,
           (bound_addr.sin_addr.s_addr >> 8) & 0xFF,
           (bound_addr.sin_addr.s_addr >> 16) & 0xFF,
           (bound_addr.sin_addr.s_addr >> 24) & 0xFF);
    
    close(sockfd);
    return 0;
}
    `;

    fs.writeFileSync(path.join(workspaceDir, 'server_static.c'), cProgramContent);

    // Compile statically using /usr/bin/gcc.real directly to bypass the gcc wrapper filter
    const compileRes = await container.exec([
      '/usr/bin/gcc.real',
      '-static',
      '-o',
      '/workspace/server_static',
      '/workspace/server_static.c'
    ]);
    expect(compileRes.exitCode).toBe(0);

    // Run the statically compiled server
    const runRes = await container.exec([
      '/workspace/server_static'
    ]);
    expect(runRes.exitCode).toBe(0);

    console.log(`[Challenger Static Binary Bind] stdout=${runRes.stdout.trim()}`);
    // If the bind was NOT redirected to 127.0.0.1, the output will contain bound_ip=0.0.0.0
    expect(runRes.stdout).toContain('bound_ip=0.0.0.0');
  });

  // 4. Test if iptables inbound blocking on external IP is active and working
  test('should verify iptables rules block inbound connections on the external interface', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1'] // puts in bridge mode to configure iptables
    }));

    // Inspect the iptables rules using raw dockerode (running as root)
    const rawContainer = docker.getContainer(container.id);
    const execInstance = await rawContainer.exec({
      Cmd: ['iptables', '-S', 'INPUT'],
      AttachStdout: true,
      AttachStderr: true,
      User: 'root'
    });
    const stream = await execInstance.start({ Detach: false });
    
    let iptablesOutput = '';
    await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => {
        iptablesOutput += chunk.toString();
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    console.log(`[Challenger iptables INPUT rules]:\n${iptablesOutput.trim()}`);
    
    // The policy should be DROP
    expect(iptablesOutput).toContain('-P INPUT DROP');
    // There should be a rule accepting traffic on loopback (lo)
    expect(iptablesOutput).toContain('-A INPUT -i lo -j ACCEPT');
    // There should be a rule accepting ESTABLISHED/RELATED
    expect(iptablesOutput).toContain('-A INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT');
    
    // There should NOT be any rule accepting incoming packets on eth0 or external interface (excluding lo and RELATED,ESTABLISHED)
    const hasInsecureAccept = iptablesOutput.split('\n').some(line => {
      const clean = line.trim();
      return clean.includes('-A INPUT') && 
             clean.includes('ACCEPT') && 
             !clean.includes('-i lo') && 
             !clean.includes('RELATED,ESTABLISHED');
    });
    expect(hasInsecureAccept).toBe(false);
  });
});
