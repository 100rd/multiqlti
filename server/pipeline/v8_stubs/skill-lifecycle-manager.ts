import { Skill } from "@shared/schema";

export interface SkillLifecycleState {
  version: string;
  status: "draft" | "active" | "deprecated" | "recalled";
  updatedAt: Date;
}

export class SkillLifecycleManager {
  private activeSkills: Map<string, SkillLifecycleState> = new Map();

  async registerSkill(skill: Skill): Promise<boolean> {
    if (!skill.id || !skill.version) {
      throw new Error("Invalid skill: Missing ID or version.");
    }
    this.activeSkills.set(skill.id, {
      version: skill.version,
      status: "draft",
      updatedAt: new Date(),
    });
    return true;
  }

  async transitionTo(
    skillId: string,
    status: SkillLifecycleState["status"],
  ): Promise<void> {
    const skillState = this.activeSkills.get(skillId);
    if (!skillState) {
      throw new Error(`Skill ${skillId} is not registered.`);
    }
    skillState.status = status;
    skillState.updatedAt = new Date();
    this.activeSkills.set(skillId, skillState);
  }

  async getSkillState(skillId: string): Promise<SkillLifecycleState | undefined> {
    return this.activeSkills.get(skillId);
  }
}
