import type { OpenSpec, SpecRequirement } from "@shared/types";
import { simpleGit } from "simple-git";
import * as path from "path";
import * as fs from "fs/promises";
import * as crypto from "crypto";

export interface RalphLoopContext {
  worktreePath: string;
  spec: OpenSpec;
  activeRequirement: SpecRequirement;
}

export class RalphLoopManager {
  private baseRepoPath: string;

  constructor(baseRepoPath: string) {
    this.baseRepoPath = baseRepoPath;
  }

  /**
   * Initializes a fresh, isolated Git worktree for a specific requirement.
   * This is Axis 1 (Context Management) & Axis 7 (Safeguards) in action.
   * State lives in the file system/git, NOT in the LLM's conversation history.
   */
  public async spawnIsolatedContext(spec: OpenSpec, requirement: SpecRequirement): Promise<RalphLoopContext> {
    const git = simpleGit(this.baseRepoPath);
    
    // Generate a unique branch and worktree path for this specific requirement execution
    const runId = crypto.randomBytes(4).toString("hex");
    const branchName = `dark-factory/${spec.id}-${requirement.id}-${runId}`;
    const worktreePath = path.join(this.baseRepoPath, ".claude", "worktrees", branchName);

    // Create the directory if it doesn't exist
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });

    try {
      // Create a new branch from main (or current state)
      await git.checkoutLocalBranch(branchName);
      
      // Add the worktree
      await git.raw(["worktree", "add", worktreePath, branchName]);

      return {
        worktreePath,
        spec,
        activeRequirement: requirement,
      };
    } catch (error) {
      console.error(`Failed to create isolated context for ${requirement.id}:`, error);
      throw error;
    }
  }

  /**
   * Cleans up the worktree after evaluation (pass or fail).
   */
  public async destroyIsolatedContext(context: RalphLoopContext): Promise<void> {
    const git = simpleGit(this.baseRepoPath);
    try {
      await git.raw(["worktree", "remove", context.worktreePath, "--force"]);
      await git.branch(["-D", path.basename(context.worktreePath)]);
    } catch (error) {
      console.error(`Failed to destroy worktree ${context.worktreePath}:`, error);
    }
  }
}
