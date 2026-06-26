const fs = require('fs');
const path = require('path');
const os = require('os');
const Docker = require('dockerode');
const net = require('net');
const { IsolatedWorkspaceManager } = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(180000); // 3 minutes timeout

describe('Challenger M6 Robustness and Adversarial Verification Suite', () => {
  let containersToCleanup = [];
  let dirsToCleanup = [];
  const docker = new Docker();

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-challenger-m6-robust-'));
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
    await Promise.all(
      containersToCleanup.map(async (container) => {
        try {
          await container.stop();
        } catch (e) {
          // Ignore
        }
      })
    );
    containersToCleanup = [];

    // Clean up directories
    for (const dir of dirsToCleanup) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        // Ignore
      }
    }
    dirsToCleanup = [];
  });

  // 1. Python Wrapper Bypass and Environment Variable Manipulation
  describe('Python Wrapper & Environment Modification Bypasses', () => {
    test('should verify if env -i python3.real bypasses loopback bind redirection', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      const container = registerContainer(await manager.createSandboxA({
        workspaceDir,
        allowList: ['1.1.1.1'] // puts in bridge mode
      }));

      // Start http.server using env -i python3.real
      await container.exec([
        'sh',
        '-c',
        'env -i python3.real -m http.server 8089 & PID=$!; for i in $(seq 1 10); do netstat -an | grep 8089 && break; sleep 0.5; done; kill $PID'
      ]);

      const netstatRes = await container.exec([
        'sh',
        '-c',
        'env -i python3.real -m http.server 8089 & PID=$!; sleep 1.5; netstat -an | grep 8089; kill $PID'
      ]);

      console.log('netstat output for env -i python3.real:', netstatRes.stdout);
      // Since ld.so.preload is globally configured in /etc/ld.so.preload, it should STILL apply
      // even when the environment is cleared with env -i.
      expect(netstatRes.stdout).toContain('127.0.0.1:8089');
      expect(netstatRes.stdout).not.toContain('0.0.0.0:8089');
    });

    test('should verify python execution bypasses via piping and check keyword blocks', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      const container = registerContainer(await manager.createSandboxA({ workspaceDir }));

      // Piping a blocklisted keyword
      const pipelinedRes = await container.exec([
        'sh',
        '-c',
        'echo "import http.server" | python3'
      ]);
      expect(pipelinedRes.exitCode).toBe(1);
      expect(pipelinedRes.stderr).toContain('Security Error');
    });
  });

  // 2. Sensitive Paths & Subdirectories Mounting
  describe('Sensitive Paths and Subdirectories Mount Block', () => {
    test('should reject mounting sensitive host directories and subdirectories thereof', async () => {
      const manager = new IsolatedWorkspaceManager();
      
      const sensitivePaths = [
        '/etc',
        '/var',
        '/usr',
        '/usr/bin',
        '/private',
        '/private/etc',
        '/Library',
        '/System',
        '/Users'
      ];

      for (const sPath of sensitivePaths) {
        await expect(
          manager.createSandboxA({ workspaceDir: sPath })
        ).rejects.toThrow(/Sensitive root\/system directory mount blocked/);
      }
    });
  });

  // 3. Port Listening and Inbound Blocking (iptables)
  describe('Inbound Network Traffic & iptables Verification', () => {
    test('should block host connections to dynamic binary listening inside container on external IP', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      const container = registerContainer(await manager.createSandboxA({
        workspaceDir,
        allowList: ['1.1.1.1'] // puts in bridge mode to get an external IP
      }));

      // Get container IP address inside bridge network
      const ipResult = await container.exec(['sh', '-c', "ip route | grep src | awk '{print $NF}'"]);
      const containerIp = ipResult.stdout.trim();
      expect(containerIp).toMatch(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/);
      console.log('Container external IP:', containerIp);

      // Start a node TCP server inside the container listening on ALL interfaces (0.0.0.0:8082).
      // Node is dynamically linked, so ld.so.preload bind_shortcut will redirect it to 127.0.0.1:8082.
      await container.exec([
        'sh',
        '-c',
        'node -e "require(\'net\').createServer(s => s.pipe(s)).listen(8082, \'0.0.0.0\')" &'
      ]);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 1. Internal check: Check if it's running and bound to 127.0.0.1
      const netstatRes = await container.exec(['netstat', '-an']);
      expect(netstatRes.stdout).toContain('127.0.0.1:8082');
      expect(netstatRes.stdout).not.toContain('0.0.0.0:8082');

      // 2. External check: Try connecting from the host to the container's external IP:8082.
      // This should fail because:
      // a) The server is only bound to 127.0.0.1 anyway (due to bind_shortcut)
      // b) iptables drops incoming traffic on the external interface.
      const connectToContainer = () => {
        return new Promise((resolve) => {
          const client = net.connect({ host: containerIp, port: 8082, timeout: 2000 }, () => {
            client.end();
            resolve(true); // Connected
          });
          client.on('error', () => resolve(false));
          client.on('timeout', () => {
            client.destroy();
            resolve(false); // Timeout
          });
        });
      };

      const isConnected = await connectToContainer();
      expect(isConnected).toBe(false);
    });
  });

  // 4. Static Binaries Listening & iptables Inbound Blocking
  describe('Static Binaries and Inbound Blocking', () => {
    test('should prevent external traffic to static binaries bound to 0.0.0.0', async () => {
      const workspaceDir = createTempDir();
      const manager = new IsolatedWorkspaceManager();
      const container = registerContainer(await manager.createSandboxA({
        workspaceDir,
        allowList: ['1.1.1.1'] // puts in bridge mode to get external IP
      }));

      // Get container IP address inside bridge network
      const ipResult = await container.exec(['sh', '-c', "ip route | grep src | awk '{print $NF}'"]);
      const containerIp = ipResult.stdout.trim();

      // Write C code for a TCP server that listens on 0.0.0.0:8083 and responds to clients
      const cProgram = `
#include <sys/socket.h>
#include <netinet/in.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>

int main() {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 1;
    int opt = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(8083);
    if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) return 2;
    if (listen(fd, 5) < 0) return 3;
    printf("bound_listening_0.0.0.0\\n");
    fflush(stdout);
    
    // Accept one connection and print message
    struct sockaddr_in client_addr;
    socklen_t client_len = sizeof(client_addr);
    int client_fd = accept(fd, (struct sockaddr*)&client_addr, &client_len);
    if (client_fd >= 0) {
        write(client_fd, "hello\\n", 6);
        close(client_fd);
    }
    close(fd);
    return 0;
}
`;
      fs.writeFileSync(path.join(workspaceDir, 'server.c'), cProgram);

      // Compile using real gcc to force truly static linking, bypassing the gcc wrapper
      const compileRes = await container.exec([
        '/usr/bin/gcc.real',
        '-static',
        '-o',
        '/workspace/server_static',
        '/workspace/server.c'
      ]);
      expect(compileRes.exitCode).toBe(0);

      // Start the static binary in the background
      await container.exec([
        'sh',
        '-c',
        '/workspace/server_static &'
      ]);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify that it is bound to 0.0.0.0:8083 (proving ld.so.preload was bypassed by static binary)
      const netstatRes = await container.exec(['netstat', '-an']);
      expect(netstatRes.stdout).toContain('0.0.0.0:8083');
      expect(netstatRes.stdout).not.toContain('127.0.0.1:8083');

      // Attempt to connect from the host to the static binary inside the container via external IP
      const connectToContainer = () => {
        return new Promise((resolve) => {
          const client = net.connect({ host: containerIp, port: 8083, timeout: 2000 }, () => {
            client.end();
            resolve(true); // Connected
          });
          client.on('error', () => resolve(false));
          client.on('timeout', () => {
            client.destroy();
            resolve(false); // Timeout
          });
        });
      };

      const isConnected = await connectToContainer();
      
      // The connection MUST be blocked by iptables rules (INPUT DROP), so isConnected must be false.
      expect(isConnected).toBe(false);
    });
  });
});
