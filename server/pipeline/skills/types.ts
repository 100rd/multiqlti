export type SkillStage = 'provenance' | 'quarantine' | 'versioned' | 'success-delta' | 'deprecated';

export interface LifecycleSkill {
  id: string;
  stage: SkillStage;
  successDelta: number; // success rate bounded between 0.0 and 1.0
  tags: string[];
  code: string;         // executable skill body
  meta: Record<string, any>;
  version: string;
  provenance: 'human' | 'system' | 'internet';
  validatedModel: string;
  validatedEnv: string;
  memoryBindingId?: string;
}

/**
 * Custom exception thrown when trying to execute a quarantined skill without authorization.
 */
export class RequiresHumanAdmission extends Error {
  public readonly skillId: string;

  constructor(skillId: string) {
    super(`RequiresHumanAdmission: LifecycleSkill "${skillId}" is in quarantine and cannot be executed without human-gate override.`);
    this.name = 'RequiresHumanAdmission';
    this.skillId = skillId;
    
    // Restore prototype chain for ES5/Jest/TypeScript subclassing compatibility
    Object.setPrototypeOf(this, RequiresHumanAdmission.prototype);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RequiresHumanAdmission);
    }
  }
}
