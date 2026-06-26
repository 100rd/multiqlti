import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UnauthorizedExecutionError } from './errors';

export interface TaskConfig {
  command: string;
  cwd: string;
  token?: string;
}

export interface TaskResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function copyRecursiveSync(src: string, dest: string) {
  const stats = fs.lstatSync(src);
  if (stats.isSymbolicLink()) {
    const target = fs.readlinkSync(src);
    fs.symlinkSync(target, dest);
  } else if (stats.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(
        path.join(src, childItemName),
        path.join(dest, childItemName)
      );
    });
    fs.chmodSync(dest, stats.mode);
  } else {
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, stats.mode);
  }
}

function makeWritableRecursiveSync(dir: string) {
  try {
    const stats = fs.lstatSync(dir);
    if (stats.isSymbolicLink()) {
      return;
    }
    if (stats.isDirectory()) {
      fs.chmodSync(dir, 0o777);
      fs.readdirSync(dir).forEach((file) => {
        makeWritableRecursiveSync(path.join(dir, file));
      });
    } else {
      fs.chmodSync(dir, 0o666);
    }
  } catch (err) {
    // ignore
  }
}

function clearDirectorySync(dir: string) {
  if (fs.existsSync(dir)) {
    makeWritableRecursiveSync(dir);
    fs.readdirSync(dir).forEach((file) => {
      const curPath = path.join(dir, file);
      fs.rmSync(curPath, { recursive: true, force: true });
    });
  }
}

function getScopes(token: string): string[] {
  if (!token.startsWith('Bearer ')) {
    throw new UnauthorizedExecutionError('Invalid token format. Must start with "Bearer "');
  }
  const payloadStr = token.substring(7).trim();
  
  const extractFromValue = (val: any): string[] | null => {
    if (Array.isArray(val)) {
      return val.map((s: any) => String(s).trim());
    }
    if (val && typeof val === 'object') {
      if (Array.isArray(val.scopes)) {
        return val.scopes.map((s: any) => String(s).trim());
      }
      if (typeof val.scopes === 'string') {
        return val.scopes.split(/[\s,]+/).map((s: string) => s.trim()).filter(Boolean);
      }
    }
    return null;
  };

  // 1. Try direct JSON
  try {
    const parsed = JSON.parse(payloadStr);
    const scopes = extractFromValue(parsed);
    if (scopes) return scopes;
  } catch (e) {
    // ignore
  }

  // 2. Try Base64 JSON or plain Base64
  let base64Decoded = '';
  let isBase64Valid = false;
  try {
    base64Decoded = Buffer.from(payloadStr, 'base64').toString('utf8');
    // Check if it consists of printable ASCII / whitespace
    if (/^[\x20-\x7E\r\n\t]*$/.test(base64Decoded)) {
      isBase64Valid = true;
    }
  } catch (e) {
    // ignore
  }

  if (isBase64Valid && base64Decoded) {
    try {
      const parsed = JSON.parse(base64Decoded);
      const scopes = extractFromValue(parsed);
      if (scopes) return scopes;
    } catch (e) {
      const scopes = base64Decoded.split(/[\s,]+/).map((s: string) => s.trim()).filter(Boolean);
      if (scopes.length > 0) {
        return scopes;
      }
    }
  }

  // 3. Simple list
  return payloadStr.split(/[\s,]+/).map((s: string) => s.trim()).filter(Boolean);
}

function hasUnquotedGroupingOrSubshell(cmd: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (char === '(' || char === ')' || char === '{' || char === '}' || char === '`') {
        return true;
      }
    }
  }
  return false;
}

function hasEvaluatableSubshell(cmd: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (!inSingleQuote) {
      if (char === '`') {
        return true;
      }
      if (char === '$' && cmd[i + 1] === '(') {
        return true;
      }
    }
  }
  return false;
}

function splitSegments(cmd: string): string[] {
  const segments: string[] = [];
  let currentSegment = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];

    if (escaped) {
      currentSegment += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      currentSegment += char;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      currentSegment += char;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      currentSegment += char;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (char === '&' && cmd[i + 1] === '&') {
        segments.push(currentSegment);
        currentSegment = '';
        i++;
        continue;
      }
      if (char === '|' && cmd[i + 1] === '|') {
        segments.push(currentSegment);
        currentSegment = '';
        i++;
        continue;
      }
      if (char === ';' || char === '\n' || char === '|' || char === '&') {
        segments.push(currentSegment);
        currentSegment = '';
        continue;
      }
    }

    currentSegment += char;
  }

  segments.push(currentSegment);
  return segments.map(s => s.trim()).filter(Boolean);
}

function expandVariables(segment: string, env: Record<string, string>): string {
  let result = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      result += char;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      result += char;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      result += char;
      continue;
    }

    if (!inSingleQuote && char === '$') {
      if (segment[i + 1] === '{') {
        let j = i + 2;
        let varName = '';
        while (j < segment.length && segment[j] !== '}') {
          varName += segment[j];
          j++;
        }
        if (j < segment.length && segment[j] === '}') {
          const val = env[varName] !== undefined ? env[varName] : (process.env[varName] !== undefined ? process.env[varName]! : '');
          result += val;
          i = j;
          continue;
        }
      } else {
        let j = i + 1;
        if (j < segment.length && /[a-zA-Z_]/.test(segment[j])) {
          let varName = segment[j];
          j++;
          while (j < segment.length && /\w/.test(segment[j])) {
            varName += segment[j];
            j++;
          }
          const val = env[varName] !== undefined ? env[varName] : (process.env[varName] !== undefined ? process.env[varName]! : '');
          result += val;
          i = j - 1;
          continue;
        }
      }
    }

    result += char;
  }

  return result;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let currentToken = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  let hasChars = false;

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];

    if (escaped) {
      currentToken += char;
      hasChars = true;
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      hasChars = true;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      hasChars = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && /\s/.test(char)) {
      if (currentToken || hasChars) {
        tokens.push(currentToken);
        currentToken = '';
        hasChars = false;
      }
      continue;
    }

    currentToken += char;
    hasChars = true;
  }

  if (currentToken || hasChars) {
    tokens.push(currentToken);
  }

  return tokens;
}

function isRedirectionOperator(token: string): boolean {
  return /^[0-9]*[<>]+/.test(token) || token === '&>' || /^[0-9]+[<>]+&[0-9]+/.test(token);
}

function consumesNextToken(token: string): boolean {
  if (/[<>&]&[0-9]+$/.test(token) || /^[0-9]+[<>]+&[0-9]+/.test(token)) {
    return false;
  }
  return true;
}

function getRequiredScopes(command: string): string[] {
  if (hasUnquotedGroupingOrSubshell(command) || hasEvaluatableSubshell(command)) {
    throw new UnauthorizedExecutionError('Command contains grouping or subshell characters outside of quotes.');
  }

  const scopes: string[] = [];
  const segments = splitSegments(command);
  const env: Record<string, string> = {};
  const shellPrefixes = new Set(['exec', 'env', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'tcsh', 'csh', 'sudo', 'nohup', 'eval', 'xargs']);
  const optionsWithArgs = new Set(['-u', '--user', '-g', '--group', '-C', '--close-from', '--chdir', '-D', '-p', '--prompt', '-R', '--chroot', '-T', '--timeout', '-h', '--host', '-r', '--role', '-t', '--type', '-c', '-o', '-O', '-I', '-a']);

  for (const segment of segments) {
    const expanded = expandVariables(segment, env);
    const rawWords = tokenize(expanded);
    if (rawWords.length === 0) continue;

    const words: string[] = [];
    for (let i = 0; i < rawWords.length; i++) {
      const w = rawWords[i];
      if (isRedirectionOperator(w)) {
        if (consumesNextToken(w)) {
          i++;
        }
      } else {
        words.push(w);
      }
    }

    if (words.length === 0) continue;

    let firstWordIndex = 0;
    let skippedAnyPrefix = false;
    let processedSubcommand = false;
    while (firstWordIndex < words.length) {
      const word = words[firstWordIndex];
      if (word.includes('=')) {
        const idx = word.indexOf('=');
        const varName = word.substring(0, idx);
        const varVal = word.substring(idx + 1);
        if (/^[a-zA-Z_]\w*$/.test(varName)) {
          env[varName] = varVal;
        }
        firstWordIndex++;
        continue;
      }

      let isPrefix = false;
      if (!word.startsWith('.')) {
        isPrefix = shellPrefixes.has(word);
        if (!isPrefix) {
          for (const prefix of shellPrefixes) {
            if (word.endsWith('/' + prefix)) {
              isPrefix = true;
              break;
            }
          }
        }
      }

      if (isPrefix) {
        skippedAnyPrefix = true;
        if (word === 'eval' || word.endsWith('/eval')) {
          processedSubcommand = true;
          const restOfCommand = words.slice(firstWordIndex + 1).join(' ');
          const subScopes = getRequiredScopes(restOfCommand);
          scopes.push(...subScopes);
          firstWordIndex = words.length;
          break;
        }
        firstWordIndex++;
        continue;
      }

      if (word.startsWith('-')) {
        if (optionsWithArgs.has(word)) {
          if (word === '-c') {
            processedSubcommand = true;
            const subCommand = words[firstWordIndex + 1];
            if (subCommand) {
              const subScopes = getRequiredScopes(subCommand);
              scopes.push(...subScopes);
            }
            firstWordIndex += 2;
          } else {
            firstWordIndex += 2;
          }
        } else {
          firstWordIndex++;
        }
        continue;
      }

      break;
    }

    if (firstWordIndex >= words.length) {
      if (skippedAnyPrefix && !processedSubcommand) {
        if (!scopes.includes('fs:delete')) {
          scopes.push('fs:delete');
        }
        if (!scopes.includes('deploy')) {
          scopes.push('deploy');
        }
      }
      continue;
    }

    const firstWord = words[firstWordIndex];

    if (/[*?]/.test(firstWord)) {
      throw new UnauthorizedExecutionError(`Command executable contains wildcard characters: ${firstWord}`);
    }

    const baseName = path.basename(firstWord).toLowerCase();

    // Check if the command is a local prefix interpreter (starts with . and name in shellPrefixes)
    if (firstWord.startsWith('.') && shellPrefixes.has(baseName)) {
      if (!scopes.includes('fs:delete')) {
        scopes.push('fs:delete');
      }
      if (!scopes.includes('deploy')) {
        scopes.push('deploy');
      }
    }

    if (baseName === 'deploy' || baseName.startsWith('deploy.')) {
      if (!scopes.includes('deploy')) {
        scopes.push('deploy');
      }
    }

    if (baseName === 'rm') {
      let hasR = false;
      let hasF = false;
      let hasRecursiveLong = false;
      let hasForceLong = false;

      const args = words.slice(firstWordIndex + 1);
      for (const arg of args) {
        if (arg.startsWith('--')) {
          const lowerArg = arg.toLowerCase();
          if (lowerArg === '--recursive') {
            hasRecursiveLong = true;
          } else if (lowerArg === '--force') {
            hasForceLong = true;
          }
        } else if (arg.startsWith('-') && arg !== '-') {
          const chars = arg.slice(1).toLowerCase();
          if (chars.includes('r')) {
            hasR = true;
          }
          if (chars.includes('f')) {
            hasF = true;
          }
        }
      }

      const isRecursive = hasR || hasRecursiveLong;
      const isForce = hasF || hasForceLong;
      if (isRecursive && isForce) {
        if (!scopes.includes('fs:delete')) {
          scopes.push('fs:delete');
        }
      }
    }

    // Additional engines/tools checks
    if (baseName === 'find') {
      const args = words.slice(firstWordIndex + 1);
      if (args.some(arg => arg === '-delete')) {
        if (!scopes.includes('fs:delete')) {
          scopes.push('fs:delete');
        }
      }
    }

    if (baseName === 'node' || baseName === 'nodejs' || baseName === 'python' || baseName === 'python3' || baseName === 'python2') {
      const args = words.slice(firstWordIndex + 1);
      const fullArgsString = args.join(' ');
      if (/rmtree|rmsync|rmdir|unlink|fs\.rm|promises\.rm/i.test(fullArgsString)) {
        if (!scopes.includes('fs:delete')) {
          scopes.push('fs:delete');
        }
      }
      if (/deploy/i.test(fullArgsString)) {
        if (!scopes.includes('deploy')) {
          scopes.push('deploy');
        }
      }
    }
  }

  return scopes;
}

export async function executeTask(config: TaskConfig): Promise<TaskResult> {
  // Command authorization check BEFORE snapshot creation and command execution.
  const requiredScopes = getRequiredScopes(config.command);
  if (requiredScopes.length > 0) {
    if (!config.token) {
      throw new UnauthorizedExecutionError(
        `Unauthorized: Command requires scopes: ${requiredScopes.join(', ')} but no token was provided.`
      );
    }
    const tokenScopes = getScopes(config.token);
    for (const req of requiredScopes) {
      if (!tokenScopes.includes(req)) {
        throw new UnauthorizedExecutionError(
          `Unauthorized: Token lacks required scope: ${req}`
        );
      }
    }
  }

  // Create snapshot
  const tempBackupPrefix = path.join(os.tmpdir(), 'task-backup-');
  const tempBackupDir = fs.mkdtempSync(tempBackupPrefix);

  try {
    copyRecursiveSync(config.cwd, tempBackupDir);
  } catch (err) {
    // Cleanup and propagate
    makeWritableRecursiveSync(tempBackupDir);
    fs.rmSync(tempBackupDir, { recursive: true, force: true });
    throw err;
  }

  const handleFailure = (err: any) => {
    try {
      clearDirectorySync(config.cwd);
      copyRecursiveSync(tempBackupDir, config.cwd);
    } catch (rollbackErr) {
      console.error('Failed to restore from backup:', rollbackErr);
    } finally {
      makeWritableRecursiveSync(tempBackupDir);
      fs.rmSync(tempBackupDir, { recursive: true, force: true });
    }
    throw err;
  };

  return new Promise<TaskResult>((resolve, reject) => {
    exec(config.command, { cwd: config.cwd }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      const result: TaskResult = {
        exitCode,
        stdout,
        stderr
      };

      if (exitCode !== 0 || error) {
        try {
          handleFailure(error || new Error(`Command failed with exit code ${exitCode}`));
        } catch (failErr) {
          reject(failErr);
        }
      } else {
        try {
          makeWritableRecursiveSync(tempBackupDir);
          fs.rmSync(tempBackupDir, { recursive: true, force: true });
        } catch (cleanupErr) {
          // ignore
        }
        resolve(result);
      }
    });
  });
}
