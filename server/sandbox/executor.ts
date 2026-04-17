import Docker from "dockerode";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync, rmSync, writeFile } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { SandboxConfig, SandboxFile, SandboxResult, SandboxHardeningConfig } from "@shared/types";
import { SANDBOX_DEFAULTS } from "@shared/constants";
import { selectRuntime, RUNTIME_RUNSC } from "./runtime";
import { generateSeccompProfile } from "./seccomp";
import { validateEgressAllowList } from "./network-policy";
import { promisify } from "util";

const writeFileAsync = promisify(writeFile);

export class SandboxExecutor {
  private docker: Docker;

  constructor() {
    this.docker = new Docker({ socketPath: "/var/run/docker.sock" });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async execute(
    config: SandboxConfig,
    files: SandboxFile[],
    onOutput?: (stream: "stdout" | "stderr", data: string) => void,
    hardening?: SandboxHardeningConfig,
  ): Promise<SandboxResult> {
    if (!(await this.isAvailable())) {
      throw new Error(
        "Docker daemon is not running or not accessible at /var/run/docker.sock",
      );
    }

    const tmpDir = join(tmpdir(), `multiqlti-sandbox-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
      this.writeFiles(tmpDir, files);
      await this.ensureImage(config.image);
      return await this.runContainer(tmpDir, config, onOutput, hardening);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private writeFiles(tmpDir: string, files: SandboxFile[]): void {
    for (const file of files) {
      const filePath = join(tmpDir, file.path);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content, "utf-8");
    }
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, (pullErr: Error | null) => {
            if (pullErr) return reject(pullErr);
            resolve();
          });
        });
      });
    }
  }

  private async buildDockerArgs(
    config: SandboxConfig,
    tmpDir: string,
    hardening?: SandboxHardeningConfig,
  ): Promise<string[]> {
    const memory = config.memoryLimit ?? SANDBOX_DEFAULTS.memoryLimit;
    const cpus = String(config.cpuLimit ?? SANDBOX_DEFAULTS.cpuLimit);
    const workdir = config.workdir ?? SANDBOX_DEFAULTS.workdir;
    const name = `multiqlti-${randomUUID().slice(0, 8)}`;

    // ── Runtime selection ─────────────────────────────────────────────────────
    const runtimeInfo = await selectRuntime(this.docker, hardening?.runtime);
    const egressAllowList = hardening?.egressAllowList ?? [];
    const normalisedEgress = validateEgressAllowList(egressAllowList);
    const hasEgress = normalisedEgress.length > 0;

    // ── Network ───────────────────────────────────────────────────────────────
    // Default-deny: use "none" when no egress allow-list is declared.
    // When allow-list entries are present, a bridge network is used and
    // iptables rules would be applied by a privileged sidecar (not implemented
    // here — this keeps the Docker args correct for both scenarios).
    const network = hasEgress ? "bridge" : "none";

    const args = [
      "run",
      "--rm",
      `--name=${name}`,
      `--memory=${memory}`,
      `--cpus=${cpus}`,
      `--network=${network}`,
      `--workdir=${workdir}`,
      "-v", `${tmpDir}:${workdir}:rw`,
      "--security-opt=no-new-privileges",
      "--cap-drop=ALL",
    ];

    // ── gVisor runtime ────────────────────────────────────────────────────────
    // runsc provides kernel-level isolation; skip AppArmor/seccomp since gVisor
    // enforces its own stricter syscall filtering.
    if (runtimeInfo.name === RUNTIME_RUNSC) {
      args.push(`--runtime=${RUNTIME_RUNSC}`);
    } else {
      // ── Seccomp (runc only) ───────────────────────────────────────────────
      const applySeccomp = hardening?.applySeccomp !== false;
      if (applySeccomp) {
        const seccompJson = generateSeccompProfile({
          allowNetworkSyscalls: hasEgress,
        });
        // Write seccomp profile to a temp file Docker can read
        const seccompPath = join(tmpDir, ".seccomp.json");
        writeFileSync(seccompPath, seccompJson, "utf-8");
        args.push(`--security-opt=seccomp=${seccompPath}`);
      }

      // ── AppArmor (runc only, Linux host only) ─────────────────────────────
      const applyAppArmor = hardening?.applyAppArmor === true;
      if (applyAppArmor) {
        args.push(`--security-opt=apparmor=multiqlti-sandbox`);
      }
    }

    // ── Environment variables ─────────────────────────────────────────────────
    if (config.env) {
      for (const [key, val] of Object.entries(config.env)) {
        args.push("-e", `${key}=${val}`);
      }
    }

    const shellCmd = config.installCommand
      ? `${config.installCommand} && ${config.command}`
      : config.command;

    args.push(config.image, "sh", "-c", shellCmd);
    return args;
  }

  private runContainer(
    tmpDir: string,
    config: SandboxConfig,
    onOutput?: (stream: "stdout" | "stderr", data: string) => void,
    hardening?: SandboxHardeningConfig,
  ): Promise<SandboxResult> {
    const timeout = (config.timeout ?? SANDBOX_DEFAULTS.timeout) * 1000;
    const startMs = Date.now();

    return new Promise((resolve, reject) => {
      this.buildDockerArgs(config, tmpDir, hardening)
        .then((args) => {
          let stdout = "";
          let stderr = "";
          let timedOut = false;

          const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });

          const timer = setTimeout(() => {
            timedOut = true;
            proc.kill("SIGKILL");
          }, timeout);

          proc.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf-8");
            stdout += text;
            onOutput?.("stdout", text);
          });

          proc.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf-8");
            stderr += text;
            onOutput?.("stderr", text);
          });

          proc.on("close", (code) => {
            clearTimeout(timer);
            resolve({
              exitCode: code ?? 1,
              stdout,
              stderr,
              durationMs: Date.now() - startMs,
              timedOut,
              artifacts: [],
              image: config.image,
              command: config.command,
            });
          });

          proc.on("error", (err) => {
            clearTimeout(timer);
            resolve({
              exitCode: 1,
              stdout,
              stderr: stderr + `\nProcess error: ${err.message}`,
              durationMs: Date.now() - startMs,
              timedOut,
              artifacts: [],
              image: config.image,
              command: config.command,
            });
          });
        })
        .catch((err: unknown) => {
          resolve({
            exitCode: 1,
            stdout: "",
            stderr: `Failed to build docker args: ${err instanceof Error ? err.message : String(err)}`,
            durationMs: Date.now() - startMs,
            timedOut: false,
            artifacts: [],
            image: config.image,
            command: config.command,
          });
        });
    });
  }
}
