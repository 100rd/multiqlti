import type { IStorage } from "../storage";
import type { Skill, InsertSkill } from "@shared/schema";
import type { MarketplaceFilters, MarketplaceSkill } from "@shared/types";

export class MarketplaceService {
  constructor(private storage: IStorage) {}

  async search(filters: MarketplaceFilters): Promise<{ skills: MarketplaceSkill[]; total: number }> {
    return this.storage.getMarketplaceSkills(filters);
  }

  /**
   * Forks a public/team skill into the caller's collection.
   * Sets forkedFrom, resets version/usageCount, marks as private.
   */
  async fork(skillId: string, userId: string): Promise<Skill> {
    const source = await this.storage.getSkill(skillId);
    if (!source) {
      throw new Error("Skill not found");
    }

    const sharing = (source as Skill & { sharing?: string }).sharing ?? "public";
    if (sharing === "private") {
      throw new Error("Cannot fork a private skill");
    }

    const insertData: InsertSkill = {
      name: source.name,
      description: source.description,
      teamId: source.teamId,
      systemPromptOverride: source.systemPromptOverride,
      tools: source.tools,
      modelPreference: source.modelPreference,
      outputSchema: source.outputSchema,
      tags: source.tags,
      isBuiltin: false,
      isPublic: false,
      createdBy: userId,
      version: "1.0.0",
      sharing: "private",
      usageCount: 0,
      forkedFrom: skillId,
    };

    return this.storage.createSkill(insertData);
  }
}
