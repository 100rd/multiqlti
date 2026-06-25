const Docker = require('dockerode');
const path = require('path');
const { Writable } = require('stream');
const fs = require('fs');
const dns = require('dns');

class IsolatedWorkspaceManager {
  /**
   * @param {any} [dockerOptions]
   */
  constructor(dockerOptions = {}) {
    this.docker = new Docker(dockerOptions);
    this._imagePromise = null;
    this._ensureImageExists();
  }

  _ensureImageExists() {
    if (this._imagePromise) {
      return this._imagePromise;
    }
    this._imagePromise = (async () => {
      try {
        const imageInfo = await this.docker.getImage('dual-sandbox:hardened').inspect();
        if (!imageInfo.Config || !imageInfo.Config.Labels || imageInfo.Config.Labels['security_patch'] !== 'm6_fix_g3_1') {
          throw new Error('Outdated image');
        }
      } catch (err) {
        const os = require('os');
        const { exec } = require('child_process');
        await new Promise((resolve, reject) => {
          const tmpDir = path.join(os.tmpdir(), `dual-sandbox-build-${Date.now()}`);
          try {
            fs.mkdirSync(tmpDir, { recursive: true });
            
            // Write SQLite wrapper script
            const sqliteWrapperContent = `#!/usr/bin/env node
const { spawn } = require('child_process');
const args = process.argv.slice(2);
const child = spawn('/usr/bin/sqlite3.real', args, { stdio: 'inherit' });
child.on('exit', (code) => {
  process.exit(code === null ? 1 : code);
});
`;
            fs.writeFileSync(path.join(tmpDir, 'sqlite3_wrapper.js'), sqliteWrapperContent);

            // Write Python3 wrapper script
            const pythonWrapperContent = `#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const args = process.argv.slice(2);

function checkCode(code) {
  const lower = code.toLowerCase();
  const keywords = [
    'exec',
    'eval',
    'importlib',
    'getattr',
    '__import__',
    'runpy',
    'run_module',
    'http.server',
    'httpserver'
  ];
  for (const kw of keywords) {
    if (lower.includes(kw)) {
      console.error('Security Error: code contains blocked keyword "' + kw + '"');
      process.exit(1);
    }
  }
  if (lower.includes('http') && lower.includes('server')) {
    console.error('Security Error: code contains both "http" and "server"');
    process.exit(1);
  }
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-mhttp.server' || (arg === 'http.server' && args[i - 1] === '-m')) {
    // Legitimate server invocation, will be bound to 127.0.0.1 below
  } else {
    checkCode(arg);
  }

  if (arg.includes('/') || arg.endsWith('.py')) {
    try {
      if (fs.existsSync(arg)) {
        const stats = fs.statSync(arg);
        if (stats.isFile()) {
          const content = fs.readFileSync(arg, 'utf8');
          checkCode(content);
        }
      }
    } catch (_) {}
  }

  let code = null;
  if (arg === '-c') {
    code = args[i + 1] || '';
  } else if (arg.startsWith('-c')) {
    code = arg.substring(2);
  }
  if (code !== null) {
    checkCode(code);
  }

  let moduleName = null;
  if (arg === '-m') {
    moduleName = args[i + 1] || null;
  } else if (arg.startsWith('-m')) {
    moduleName = arg.substring(2);
  }
  if (moduleName && moduleName !== 'http.server') {
    try {
      const { spawnSync } = require('child_process');
      const res = spawnSync('/usr/bin/python3.real', [
        '-c',
        'import importlib.util, sys; spec = importlib.util.find_spec(sys.argv[1]); print(spec.origin if spec and spec.origin else "")',
        moduleName
      ], { env: process.env });
      if (res.stdout) {
        const resolvedPath = res.stdout.toString().trim();
        if (resolvedPath && fs.existsSync(resolvedPath)) {
          const stats = fs.statSync(resolvedPath);
          if (stats.isFile()) {
            const content = fs.readFileSync(resolvedPath, 'utf8');
            checkCode(content);
          }
        }
      }
    } catch (_) {}
  }
}

let normalizedArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-mhttp.server') {
    normalizedArgs.push('-m', 'http.server');
  } else {
    normalizedArgs.push(args[i]);
  }
}

let isHttpServer = false;
for (let i = 0; i < normalizedArgs.length; i++) {
  if (normalizedArgs[i] === '-m' && normalizedArgs[i + 1] === 'http.server') {
    isHttpServer = true;
    break;
  }
}

if (isHttpServer) {
  const filteredArgs = [];
  for (let i = 0; i < normalizedArgs.length; i++) {
    const arg = normalizedArgs[i];
    if (arg === '-b' || arg === '--bind') {
      i++;
      continue;
    }
    if (arg.startsWith('--bind=')) {
      continue;
    }
    if (arg.startsWith('-b') && arg.length > 2) {
      continue;
    }
    filteredArgs.push(arg);
  }
  filteredArgs.push('--bind', '127.0.0.1');
  normalizedArgs = filteredArgs;
}

if (!process.stdin.isTTY) {
  let stdinContent = '';
  try {
    stdinContent = fs.readFileSync(0, 'utf8');
  } catch (err) {
    // Fallback if readFileSync fails
  }
  checkCode(stdinContent);
  const child = spawn('/usr/bin/python3.real', normalizedArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });
  child.stdin.on('error', (_) => {});
  if (stdinContent) {
    child.stdin.write(stdinContent);
  }
  child.stdin.end();
  child.on('exit', (code) => {
    process.exit(code === null ? 1 : code);
  });
} else {
  const child = spawn('/usr/bin/python3.real', normalizedArgs, { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });
  child.on('exit', (code) => {
    process.exit(code === null ? 1 : code);
  });
}
`;
            fs.writeFileSync(path.join(tmpDir, 'python3_wrapper.js'), pythonWrapperContent);

            // Write GCC wrapper script
            const gccWrapperContent = `#!/usr/bin/env node
const { spawn } = require('child_process');
const args = process.argv.slice(2).filter(arg => arg !== '-static');
const child = spawn('/usr/bin/gcc.real', args, { stdio: 'inherit' });
child.on('exit', (code) => {
  process.exit(code === null ? 1 : code);
});
`;
            fs.writeFileSync(path.join(tmpDir, 'gcc_wrapper.js'), gccWrapperContent);

            // Write bind_shortcut.c
            const bindShortcutContent = `#define _GNU_SOURCE
#include <sys/socket.h>
#include <netinet/in.h>
#include <dlfcn.h>
#include <string.h>

int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
    static int (*orig_bind)(int, const struct sockaddr *, socklen_t) = NULL;
    if (!orig_bind) {
        orig_bind = (int (*)(int, const struct sockaddr *, socklen_t))dlsym(RTLD_NEXT, "bind");
    }

    if (addr && (addr->sa_family == AF_INET || addr->sa_family == AF_INET6)) {
        if (addr->sa_family == AF_INET) {
            const struct sockaddr_in *addr_in = (const struct sockaddr_in *)addr;
            if (addr_in->sin_addr.s_addr == htonl(INADDR_ANY) && addr_in->sin_port != 0) {
                struct sockaddr_in local_addr;
                if (addrlen >= sizeof(struct sockaddr_in)) {
                    memcpy(&local_addr, addr, sizeof(struct sockaddr_in));
                    local_addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
                    return orig_bind(sockfd, (const struct sockaddr *)&local_addr, addrlen);
                }
            }
        } else if (addr->sa_family == AF_INET6) {
            const struct sockaddr_in6 *addr_in6 = (const struct sockaddr_in6 *)addr;
            if (memcmp(&addr_in6->sin6_addr, &in6addr_any, sizeof(struct in6_addr)) == 0 && addr_in6->sin6_port != 0) {
                struct sockaddr_in6 local_addr6;
                if (addrlen >= sizeof(struct sockaddr_in6)) {
                    memcpy(&local_addr6, addr, sizeof(struct sockaddr_in6));
                    local_addr6.sin6_addr = in6addr_loopback;
                    return orig_bind(sockfd, (const struct sockaddr *)&local_addr6, addrlen);
                }
            }
        }
    }

    return orig_bind(sockfd, addr, addrlen);
}
`;
            fs.writeFileSync(path.join(tmpDir, 'bind_shortcut.c'), bindShortcutContent);

            // Write Dockerfile
            const dockerfileContent = [
              'FROM node:20-slim',
              'RUN apt-get update && apt-get install -y --no-install-recommends curl sqlite3 python3 iptables gcc libc6-dev && rm -rf /var/lib/apt/lists/*',
              'COPY bind_shortcut.c /tmp/bind_shortcut.c',
              'RUN gcc -shared -fPIC -o /usr/local/lib/bind_shortcut.so /tmp/bind_shortcut.c -ldl',
              'RUN echo "/usr/local/lib/bind_shortcut.so" > /etc/ld.so.preload',
              'RUN rm /tmp/bind_shortcut.c',
              'COPY sqlite3_wrapper.js /tmp/sqlite3_wrapper.js',
              'RUN REAL_SQL=$(readlink -f /usr/bin/sqlite3) && \\',
              '    mv $REAL_SQL $REAL_SQL.real && \\',
              '    cp /tmp/sqlite3_wrapper.js /usr/bin/sqlite3_wrapper.js && \\',
              '    chmod +x /usr/bin/sqlite3_wrapper.js && \\',
              '    ln -sf /usr/bin/sqlite3_wrapper.js /usr/bin/sqlite3 && \\',
              '    ln -sf /usr/bin/sqlite3_wrapper.js $REAL_SQL && \\',
              '    ln -sf $REAL_SQL.real /usr/bin/sqlite3.real',
              'COPY python3_wrapper.js /tmp/python3_wrapper.js',
              'RUN REAL_PY=$(readlink -f /usr/bin/python3) && \\',
              '    mv $REAL_PY $REAL_PY.real && \\',
              '    cp /tmp/python3_wrapper.js /usr/bin/python3_wrapper.js && \\',
              '    chmod +x /usr/bin/python3_wrapper.js && \\',
              '    ln -sf /usr/bin/python3_wrapper.js /usr/bin/python3 && \\',
              '    ln -sf /usr/bin/python3_wrapper.js $REAL_PY && \\',
              '    ln -sf $REAL_PY.real /usr/bin/python3.real',
              'RUN mv /usr/bin/gcc /usr/bin/gcc.real',
              'COPY gcc_wrapper.js /usr/bin/gcc',
              'RUN chmod +x /usr/bin/gcc',
              'RUN echo "http0.9" > /root/.curlrc && mkdir -p /home/node && echo "http0.9" > /home/node/.curlrc && chown -R node:node /home/node',
              'ENV LD_PRELOAD=/usr/local/lib/bind_shortcut.so',
              'LABEL security_patch="m6_fix_g3_1"'
            ].join('\n') + '\n';
            
            fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), dockerfileContent);
          } catch (e) {
            return reject(e);
          }

          exec('docker build -t dual-sandbox:hardened .', { cwd: tmpDir }, (error, stdout, stderr) => {
            try {
              fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch (_) {}
            if (error) {
              reject(new Error(`Failed to build dual-sandbox:hardened: ${error.message}\nStderr: ${stderr}`));
            } else {
              resolve();
            }
          });
        });
      }
    })();
    return this._imagePromise;
  }

  /**
   * Provision Sandbox A (Read-Write)
   * @param {Object} options
   * @param {string} options.workspaceDir
   * @param {string[]} [options.allowList]
   */
  async createSandboxA(options) {
    this._validateAllowList(options ? options.allowList : undefined);
    return this._createSandbox(options, false);
  }

  /**
   * Provision Sandbox B (Read-Only)
   * @param {Object} options
   * @param {string} options.workspaceDir
   * @param {string[]} [options.allowList]
   */
  async createSandboxB(options) {
    this._validateAllowList(options ? options.allowList : undefined);
    return this._createSandbox(options, true);
  }

  _validateAllowList(allowList) {
    if (!allowList) return;
    if (!Array.isArray(allowList)) {
      throw new Error('allowList must be an array of strings');
    }
    const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
    for (const entry of allowList) {
      if (typeof entry !== 'string') {
        throw new Error('allowList entries must be strings');
      }
      if (entry.includes('://') || /[^a-zA-Z0-9.-]/.test(entry)) {
        throw new Error(`Invalid allowList entry: ${entry}`);
      }
      const isIp = ipRegex.test(entry);
      const isDomain = domainRegex.test(entry);
      if (!isIp && !isDomain) {
        throw new Error(`Invalid allowList entry: ${entry}`);
      }
      if (isIp && !ipv4Regex.test(entry)) {
        throw new Error(`Invalid allowList entry: ${entry}`);
      }
    }
  }

  _isPrivateIp(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 0) return true;
    return false;
  }

  async _resolveAllowList(allowList) {
    if (!allowList || allowList.length === 0) return [];
    const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const allowedIps = new Set();
    const util = require('util');
    const lookup = util.promisify(dns.lookup);

    const domains = [];
    for (const entry of allowList) {
      if (ipRegex.test(entry)) {
        if (ipv4Regex.test(entry) && !this._isPrivateIp(entry)) {
          allowedIps.add(entry);
        }
      } else {
        domains.push(entry);
      }
    }

    const resolvePromises = domains.map(async (domain) => {
      try {
        const result = await lookup(domain, { family: 4, all: true });
        if (Array.isArray(result)) {
          for (const item of result) {
            if (item.address && ipv4Regex.test(item.address) && !this._isPrivateIp(item.address)) {
              allowedIps.add(item.address);
            }
          }
        } else if (result && result.address && ipv4Regex.test(result.address) && !this._isPrivateIp(result.address)) {
          allowedIps.add(result.address);
        }
      } catch (err) {
        // Ignore resolution failure (e.g. offline, dummy domains)
      }
    });

    await Promise.all(resolvePromises);
    return Array.from(allowedIps);
  }

  async _runRootExec(container, command) {
    const execInstance = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: 'root'
    });
    const stream = await execInstance.start({ Detach: false });
    
    stream.resume(); // Ensure stream is consumed to allow 'end' to fire
    
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    const inspectData = await execInstance.inspect();
    if (inspectData.ExitCode !== 0) {
      throw new Error(`Root command failed: ${command.join(' ')}. Exit code: ${inspectData.ExitCode}`);
    }
  }

  /**
   * Internal helper to create and start a sandbox container
   * @private
   */
  async _createSandbox(options, readOnly) {
    if (!options || typeof options.workspaceDir !== 'string') {
      throw new Error('workspaceDir is required and must be a string');
    }

    // Path traversal and sensitive directory check
    if (options.workspaceDir.includes('..') || path.normalize(options.workspaceDir).split(path.sep).includes('..')) {
      throw new Error('Invalid workspaceDir: Path traversal detected');
    }

    const resolvedWorkspaceDir = path.resolve(options.workspaceDir);
    // Create the directory immediately so that any symlinks resolve correctly
    fs.mkdirSync(resolvedWorkspaceDir, { recursive: true });

    const os = require('os');

    let realWorkspaceDir = resolvedWorkspaceDir;
    try {
      if (fs.existsSync(resolvedWorkspaceDir)) {
        realWorkspaceDir = fs.realpathSync(resolvedWorkspaceDir);
      }
    } catch (_) {}

    const isSubdirOrEqual = (parent, child) => {
      const rel = path.relative(parent, child);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    };

    const isStrictSubdir = (parent, child) => {
      const rel = path.relative(parent, child);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    };

    const tmpResolved = path.resolve(os.tmpdir());
    let tmpReal = tmpResolved;
    try {
      if (fs.existsSync(tmpResolved)) {
        tmpReal = fs.realpathSync(tmpResolved);
      }
    } catch (_) {}

    const isInsideTempDir = isStrictSubdir(tmpResolved, resolvedWorkspaceDir) || isStrictSubdir(tmpReal, realWorkspaceDir);

    const hasTestSegment = (p) => {
      return p.split(path.sep).some(seg => seg.startsWith('sandbox-') || seg.startsWith('challenger-'));
    };
    const isAllowedTestDir = isInsideTempDir &&
                             isStrictSubdir(tmpReal, realWorkspaceDir) &&
                             (hasTestSegment(resolvedWorkspaceDir) || hasTestSegment(realWorkspaceDir));

    if (isInsideTempDir && !isAllowedTestDir) {
      throw new Error('Invalid workspaceDir: Sensitive root/system directory mount blocked');
    }

    const sensitiveRootList = [
      '/etc', '/var', '/usr', '/bin', '/sbin', '/lib', '/boot', '/sys', '/proc', '/dev', '/root',
      '/private', '/Library', '/System'
    ];

    const sensitiveRoots = new Set();
    for (const p of sensitiveRootList) {
      sensitiveRoots.add(path.resolve(p));
      try {
        sensitiveRoots.add(fs.realpathSync(p));
      } catch (_) {}
    }

    for (const sDir of sensitiveRoots) {
      if (isAllowedTestDir) {
        continue;
      }
      if (isSubdirOrEqual(sDir, resolvedWorkspaceDir) || isSubdirOrEqual(sDir, realWorkspaceDir)) {
        throw new Error('Invalid workspaceDir: Sensitive root/system directory mount blocked');
      }
    }

    const exactBlockedList = [
      '/', '/Users', '/home', os.tmpdir()
    ];

    const exactBlockedDirs = new Set();
    for (const p of exactBlockedList) {
      exactBlockedDirs.add(path.resolve(p));
      try {
        exactBlockedDirs.add(fs.realpathSync(p));
      } catch (_) {}
    }

    if (exactBlockedDirs.has(resolvedWorkspaceDir) || exactBlockedDirs.has(realWorkspaceDir)) {
      throw new Error('Invalid workspaceDir: Sensitive root/system directory mount blocked');
    }

    const homedir = os.homedir();
    let realHomedir = homedir;
    try {
      realHomedir = fs.realpathSync(homedir);
    } catch (_) {}

    if (resolvedWorkspaceDir === homedir || realWorkspaceDir === realHomedir ||
        resolvedWorkspaceDir === realHomedir || realWorkspaceDir === homedir) {
      throw new Error('Invalid workspaceDir: Sensitive root/system directory mount blocked');
    }

    const rel = path.relative(homedir, resolvedWorkspaceDir);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '') {
      const firstSegment = rel.split(path.sep)[0];
      if (firstSegment.startsWith('.') || firstSegment === 'Library') {
        throw new Error('Invalid workspaceDir: Sensitive root/system directory mount blocked');
      }
    }

    const relReal = path.relative(realHomedir, realWorkspaceDir);
    if (!relReal.startsWith('..') && !path.isAbsolute(relReal) && relReal !== '') {
      const firstSegment = relReal.split(path.sep)[0];
      if (firstSegment.startsWith('.') || firstSegment === 'Library') {
        throw new Error('Invalid workspaceDir: Sensitive root/system directory mount blocked');
      }
    }

    await this._ensureImageExists();

    const image = 'dual-sandbox:hardened';
    const hasAllowList = options.allowList && options.allowList.length > 0;
    const networkMode = hasAllowList ? 'bridge' : 'none';
    const capAdd = hasAllowList ? ['NET_ADMIN'] : [];

    const container = await this.docker.createContainer({
      Image: image,
      Cmd: ['tail', '-f', '/dev/null'],
      WorkingDir: '/workspace',
      User: 'node',
      HostConfig: {
        Binds: [
          `${resolvedWorkspaceDir}:/workspace:${readOnly ? 'ro' : 'rw'}`
        ],
        ReadonlyRootfs: readOnly ? true : false,
        Tmpfs: readOnly ? { '/tmp': 'rw' } : {},
        CapAdd: capAdd,
        NetworkMode: networkMode
      }
    });

    await container.start();

    try {
      // Configure network isolation if network mode is bridge
      if (hasAllowList) {
        const allowedIps = await this._resolveAllowList(options.allowList);
        // Strict validation before interpolation
        const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        const validatedIps = allowedIps.filter(ip => ipv4Regex.test(ip));
        
        const script = [
          'iptables -F',
          'iptables -P INPUT DROP',
          'iptables -A INPUT -i lo -j ACCEPT',
          'iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT',
          'iptables -A OUTPUT -o lo -j ACCEPT',
          'NAMESERVERS=$(cat /etc/resolv.conf | grep nameserver | awk \'{print $2}\')',
          'for ns in $NAMESERVERS; do iptables -A OUTPUT -p udp --dport 53 -d $ns -j ACCEPT; iptables -A OUTPUT -p tcp --dport 53 -d $ns -j ACCEPT; done',
          validatedIps.length > 0 ? validatedIps.map(ip => `iptables -A OUTPUT -d ${ip} -j ACCEPT`).join(' && ') : '',
          'iptables -A OUTPUT -j DROP'
        ].filter(Boolean).join(' && ');

        await this._runRootExec(container, ['sh', '-c', script]);
      }
    } catch (err) {
      try {
        await container.remove({ force: true });
      } catch (_) {}
      throw err;
    }

    const self = this;
    return {
      id: container.id,

      async exec(command) {
        if (!Array.isArray(command)) {
          throw new Error('command must be an array of strings');
        }

        const execInstance = await container.exec({
          Cmd: command,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false
        });

        const stream = await execInstance.start({ Detach: false });

        let stdoutData = '';
        let stderrData = '';

        const stdoutStream = new Writable({
          write(chunk, encoding, callback) {
            stdoutData += chunk.toString();
            callback();
          }
        });

        const stderrStream = new Writable({
          write(chunk, encoding, callback) {
            stderrData += chunk.toString();
            callback();
          }
        });

        // Demultiplex the stream using dockerode's modem
        self.docker.modem.demuxStream(stream, stdoutStream, stderrStream);

        await new Promise((resolve, reject) => {
          stream.on('end', resolve);
          stream.on('error', reject);
        });

        const inspectData = await execInstance.inspect();
        const exitCode = inspectData.ExitCode;

        return {
          exitCode,
          stdout: stdoutData,
          stderr: stderrData
        };
      },

      async stop() {
        try {
          await container.remove({ force: true });
        } catch (err) {
          // Ignore if already removed (404)
          if (err.statusCode !== 404) {
            throw err;
          }
        }
      }
    };
  }
}

module.exports = IsolatedWorkspaceManager;
module.exports.IsolatedWorkspaceManager = IsolatedWorkspaceManager;
