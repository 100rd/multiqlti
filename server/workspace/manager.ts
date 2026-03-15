import path from "path";
import fs from "fs/promises";
import { simpleGit } from "simple-git";
import type { FileEntry, GitStatus } from "@shared/types";
import type { WorkspaceRow } from "@shared/schema";

const WORKSPACE_DATA_DIR = path.resolve("data/workspaces");
const MAX_FILE_SIZE_BYTES = 1_048_576; // 1 MB
const MAX_CLONE_SIZE_BYTES = 500 * 1_048_576; // 500 MB
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__"]);
const ALLOWED_WRITE_EXTENSIONS = new Set([
  ".ts", ".js", ".tsx", ".jsx", ".py", ".go", ".rs",
  ".md", ".json", ".yaml", ".yml", ".toml", ".css", ".html",
]);

export class WorkspaceManager {
  private resolveRoot(workspace: WorkspaceRow): string {
    if (workspace.type === "local") return workspace.path;
    return path.join(WORKSPACE_DATA_DIR, workspace.id);
  }

  private guardPath(root: string, filePath: string): string {
    const resolved = path.resolve(root, filePath);
    if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
      throw new Error("Path traversal attempt blocked");
    }
    return resolved;
  }

  async connectLocal(localPath: string, name?: string): Promise<{ id: string; name: string; path: string }> {
    await fs.access(localPath);
    const resolvedPath = path.resolve(localPath);
    const workspaceName = name ?? path.basename(resolvedPath);
    return { id: crypto.randomUUID(), name: workspaceName, path: resolvedPath };
  }

  async cloneRemote(
    url: string,
    workspaceId: string,
    branch = "main",
  ): Promise<void> {
    if (!url.startsWith("https://")) {
      throw new Error("Only https:// git URLs are allowed");
    }
    await fs.mkdir(path.join(WORKSPACE_DATA_DIR, workspaceId), { recursive: true });
    const dest = path.join(WORKSPACE_DATA_DIR, workspaceId);
    const git = simpleGit();
    await git.clone(url, dest, ["--depth", "1", "--branch", branch]);
    await this.checkCloneSize(dest);
  }

  private async checkCloneSize(dir: string): Promise<void> {
    const total = await this.dirSize(dir);
    if (total > MAX_CLONE_SIZE_BYTES) {
      await fs.rm(dir, { recursive: true, force: true });
      throw new Error("Cloned repository exceeds 500 MB size limit");
    }
  }

  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await this.dirSize(full);
      } else {
        const stat = await fs.stat(full);
        total += stat.size;
      }
    }
    return total;
  }

  async sync(workspace: WorkspaceRow): Promise<void> {
    if (workspace.type !== "remote") {
      throw new Error("Only remote workspaces can be synced");
    }
    const root = this.resolveRoot(workspace);
    const git = simpleGit(root);
    await git.pull();
  }

  async listFiles(workspace: WorkspaceRow, subpath = ""): Promise<FileEntry[]> {
    const root = this.resolveRoot(workspace);
    const target = subpath ? this.guardPath(root, subpath) : root;
    return this.readDir(root, target);
  }

  private async readDir(root: string, dir: string): Promise<FileEntry[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: FileEntry[] = [];

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);

      if (entry.isDirectory()) {
        result.push({ name: entry.name, path: rel, type: "directory" });
      } else {
        const stat = await fs.stat(full);
        result.push({ name: entry.name, path: rel, type: "file", size: stat.size });
      }
    }

    return result.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async readFile(workspace: WorkspaceRow, filePath: string): Promise<string> {
    const root = this.resolveRoot(workspace);
    const full = this.guardPath(root, filePath);
    const stat = await fs.stat(full);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File exceeds 1 MB limit (${stat.size} bytes)`);
    }
    return fs.readFile(full, "utf-8");
  }

  async writeFile(workspace: WorkspaceRow, filePath: string, content: string): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();
    if (!ALLOWED_WRITE_EXTENSIONS.has(ext)) {
      throw new Error(`File extension '${ext}' is not allowed for writes`);
    }
    const root = this.resolveRoot(workspace);
    const full = this.guardPath(root, filePath);
    await fs.writeFile(full, content, "utf-8");
  }

  async deleteFile(workspace: WorkspaceRow, filePath: string): Promise<void> {
    const root = this.resolveRoot(workspace);
    const full = this.guardPath(root, filePath);
    await fs.unlink(full);
  }

  async gitStatus(workspace: WorkspaceRow): Promise<GitStatus> {
    const root = this.resolveRoot(workspace);
    const git = simpleGit(root);
    const status = await git.status();
    return {
      branch: status.current ?? "unknown",
      modified: status.modified,
      staged: status.staged,
      untracked: status.not_added,
    };
  }

  async gitDiff(workspace: WorkspaceRow): Promise<string> {
    const root = this.resolveRoot(workspace);
    const git = simpleGit(root);
    return git.diff();
  }

  async gitCommit(workspace: WorkspaceRow, message: string): Promise<void> {
    const root = this.resolveRoot(workspace);
    const git = simpleGit(root);
    await git.add(".");
    await git.commit(message);
  }

  async gitBranch(workspace: WorkspaceRow, branchName: string): Promise<void> {
    const root = this.resolveRoot(workspace);
    const git = simpleGit(root);
    await git.checkoutLocalBranch(branchName);
  }

  async gitLog(workspace: WorkspaceRow, limit = 20): Promise<Array<{ hash: string; message: string; date: string; author: string }>> {
    const root = this.resolveRoot(workspace);
    const git = simpleGit(root);
    const log = await git.log({ maxCount: limit });
    return log.all.map((entry) => ({
      hash: entry.hash.slice(0, 8),
      message: entry.message,
      date: entry.date,
      author: entry.author_name,
    }));
  }

  async removeClone(workspaceId: string): Promise<void> {
    const dir = path.join(WORKSPACE_DATA_DIR, workspaceId);
    await fs.rm(dir, { recursive: true, force: true });
  }
}
