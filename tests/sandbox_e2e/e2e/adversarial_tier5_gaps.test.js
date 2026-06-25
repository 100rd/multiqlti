const fs = require('fs');
const path = require('path');
const os = require('os');
const { IsolatedWorkspaceManager } = require('../../src/IsolatedWorkspaceManager');

jest.setTimeout(120000); // 2 minutes timeout

describe('IsolatedWorkspaceManager Tier 5 White-box Adversarial Gaps Suite', () => {
  let containersToCleanup = [];
  let dirsToCleanup = [];

  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-tier5-gaps-'));
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

  // Gap 1: Symlink-based Sensitive Path Mount Bypass (Path Traversal)
  test('GAP 1: should reject mounting a subdirectory of a sensitive system directory via symlinks', async () => {
    const manager = new IsolatedWorkspaceManager();
    const testBypassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-bypass-'));
    dirsToCleanup.push(testBypassDir);
    
    const linkPath = path.join(testBypassDir, 'link_to_private');
    
    // Create symlink to /private
    fs.symlinkSync('/private', linkPath);
    
    // We request a path like: linkPath + '/tmp/my_subdir_xxxx'
    // This resolves on host to /private/tmp/my_subdir_xxxx, which is a sensitive path
    const traversalDir = path.join(linkPath, 'tmp', `my_subdir_${Date.now()}`);
    
    // The manager should reject this because /private is a sensitive system directory
    await expect(manager.createSandboxA({
      workspaceDir: traversalDir
    })).rejects.toThrow(/Sensitive root\/system directory mount blocked/);
  });

  // Gap 2: Python Wrapper Bypass via exec() and String Obfuscation
  test('GAP 2: should block python execution of http.server via exec() string obfuscation', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir,
      allowList: ['1.1.1.1']
    }));

    // Run http.server using exec string obfuscation to bypass checkCode
    const execRes = await container.exec([
      'python3',
      '-c',
      'exec("imp" + "ort ht" + "tp.se" + "rver")'
    ]);
    expect(execRes.exitCode).toBe(1);
    expect(execRes.stderr).toContain('Security Error');

    // Test eval()
    const evalRes = await container.exec([
      'python3',
      '-c',
      'eval("imp" + "ort ht" + "tp.se" + "rver")'
    ]);
    expect(evalRes.exitCode).toBe(1);
    expect(evalRes.stderr).toContain('Security Error');

    // Test getattr()
    const getattrRes = await container.exec([
      'python3',
      '-c',
      'import sys; getattr(sys, "modules")'
    ]);
    expect(getattrRes.exitCode).toBe(1);
    expect(getattrRes.stderr).toContain('Security Error');

    // Test __import__()
    const importRes = await container.exec([
      'python3',
      '-c',
      '__import__("ht" + "tp.server")'
    ]);
    expect(importRes.exitCode).toBe(1);
    expect(importRes.stderr).toContain('Security Error');
  });

  // Gap 3: LD_PRELOAD Bypass via Static Linking
  test('GAP 3: should block statically linked binaries from binding to 0.0.0.0', async () => {
    const workspaceDir = createTempDir();
    const manager = new IsolatedWorkspaceManager();
    const container = registerContainer(await manager.createSandboxA({
      workspaceDir
    }));

    // Write a C program to bind to 0.0.0.0 and print its bound IP
    const cProgramContent = `
#include <sys/socket.h>
#include <netinet/in.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>

int main() {
    int sockfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sockfd < 0) return 1;
    
    int opt = 1;
    setsockopt(sockfd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(8091);

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

    fs.writeFileSync(path.join(workspaceDir, 'server.c'), cProgramContent);

    // Compile statically
    const compileRes = await container.exec([
      'gcc',
      '-static',
      '-o',
      '/workspace/server_static',
      '/workspace/server.c'
    ]);
    expect(compileRes.exitCode).toBe(0);

    // Run statically compiled server
    const runRes = await container.exec([
      '/workspace/server_static'
    ]);
    expect(runRes.exitCode).toBe(0);

    // The output should NOT contain 0.0.0.0 if the bind was redirected
    expect(runRes.stdout).not.toContain('bound_ip=0.0.0.0');
    expect(runRes.stdout).toContain('bound_ip=127.0.0.1');
  });
});
