import { executeTask } from '../src/wrapper';
import { UnauthorizedExecutionError } from '../src/errors';
import * as fs from 'fs';
import * as path from 'path';

describe('New Authorization Bypasses Verification', () => {
  let sandboxDir: string;

  beforeEach(() => {
    const uniqueId = Math.random().toString(36).substring(2, 15);
    sandboxDir = path.resolve(__dirname, `sandbox-bypass-${uniqueId}`);
    fs.mkdirSync(sandboxDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(sandboxDir)) {
      const makeWritable = (dir: string) => {
        try {
          fs.chmodSync(dir, 0o777);
          fs.readdirSync(dir).forEach(file => {
            const curPath = path.join(dir, file);
            if (fs.lstatSync(curPath).isDirectory()) {
              makeWritable(curPath);
            } else if (!fs.lstatSync(curPath).isSymbolicLink()) {
              fs.chmodSync(curPath, 0o666);
            }
          });
        } catch (e) {}
      };
      makeWritable(sandboxDir);
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('bypasses gate via pipe to shell (echo rm -rf ... | bash)', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = `echo "rm -rf ${targetDir}" | bash`;

    // If it is bypassed, it won't throw UnauthorizedExecutionError, and it will delete targetDir
    let error: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(UnauthorizedExecutionError);
    expect(fs.existsSync(targetDir)).toBe(true);
  });

  it('bypasses gate via eval with quotes (eval "rm -rf ...")', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = `eval "rm -rf ${targetDir}"`;

    let error: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(UnauthorizedExecutionError);
    expect(fs.existsSync(targetDir)).toBe(true);
  });

  it('bypasses gate via non-rm command (find ... -delete)', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = `find ${targetDir} -delete`;

    let error: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(UnauthorizedExecutionError);
    expect(fs.existsSync(targetDir)).toBe(true);
  });

  it('bypasses gate via xargs (echo ... | xargs rm -rf)', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = `echo "${targetDir}" | xargs rm -rf`;

    let error: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(UnauthorizedExecutionError);
    expect(fs.existsSync(targetDir)).toBe(true);
  });

  it('bypasses gate via python engine execution', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = `python3 -c "import shutil; shutil.rmtree('${targetDir}')"`;

    let error: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(UnauthorizedExecutionError);
    expect(fs.existsSync(targetDir)).toBe(true);
  });

  it('bypasses gate via node engine execution', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = `node -e "require('fs').rmSync('${targetDir}', {recursive:true, force:true})"`;

    let error: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(UnauthorizedExecutionError);
    expect(fs.existsSync(targetDir)).toBe(true);
  });

  it('bypasses gate via stdin redirection (sh < input)', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const inputPath = path.join(sandboxDir, 'input.txt');
    fs.writeFileSync(inputPath, `rm -rf ${targetDir}`);

    const command = `sh < ${inputPath}`;

    let error: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(UnauthorizedExecutionError);
    expect(fs.existsSync(targetDir)).toBe(true);
  });

  it('bypasses gate via exec -a option (exec -a customname rm -rf ...)', async () => {
    const targetDir = path.join(sandboxDir, 'sub-dir');
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'content');

    const command = `exec -a customname rm -rf ${targetDir}`;

    let error: any = null;
    try {
      await executeTask({
        command,
        cwd: sandboxDir,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(UnauthorizedExecutionError);
    expect(fs.existsSync(targetDir)).toBe(true);
  });
});
