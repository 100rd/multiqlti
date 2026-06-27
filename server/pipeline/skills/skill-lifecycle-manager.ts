import { LifecycleSkill, SkillStage, RequiresHumanAdmission } from './types';
import { IObservabilityService } from './observability-interface';
import { contourObservability } from '../observability/contour-observability';
import * as acorn from 'acorn';

function splitKeyIntoTokens(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[^a-zA-Z0-9]+/).map(w => w.toLowerCase()).filter(Boolean);
}

function deepFreeze(obj: any): any {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        deepFreeze(obj[key]);
      }
    }
  }
  return obj;
}

function isolatePrototypes(obj: any): any {
  if (obj && typeof obj === 'object') {
    if (!Array.isArray(obj)) {
      Object.setPrototypeOf(obj, null);
    }
    for (const key of Object.keys(obj)) {
      isolatePrototypes(obj[key]);
    }
  }
  return obj;
}

const FORBIDDEN_CREDENTIALS = ['token', 'secret', 'auth', 'password', 'key', 'apikey', 'privatekey', 'pwd', 'pass'];
function isForbiddenCredential(nameOrValue: string): boolean {
  const lower = nameOrValue.toLowerCase();
  const sanitized = lower.replace(/[^a-z0-9]/g, '');

  if (FORBIDDEN_CREDENTIALS.includes(lower) || FORBIDDEN_CREDENTIALS.includes(sanitized)) {
    return true;
  }
  const substringForbiddens = [
    'secret', 'password', 'token', 'apikey', 'privatekey', 'pwd',
    'jwt', 'bearer', 'credential', 'allowlist', 'whitelist', 'superuser'
  ];
  for (const word of substringForbiddens) {
    if (lower.includes(word) || sanitized.includes(word)) {
      return true;
    }
  }
  // Compound/alternating checks
  if (
    (sanitized.includes('auth') && sanitized.includes('key')) ||
    (sanitized.includes('auth') && sanitized.includes('pass')) ||
    (sanitized.includes('pass') && sanitized.includes('key'))
  ) {
    return true;
  }

  const tokens = splitKeyIntoTokens(nameOrValue);
  return tokens.some(t => FORBIDDEN_CREDENTIALS.includes(t));
}

const FORBIDDEN_META_KEYS = [
  'token', 'bearer', 'jwt', 'auth', 'credential', 'secret', 'password', 'key', 'apikey', 'privatekey', 'private_key',
  'bypass', 'allowlist', 'whitelist', 'admin', 'root', 'superuser', 'permission'
];
function isForbiddenMetaKey(key: string): boolean {
  const lower = key.toLowerCase();
  const sanitized = lower.replace(/[^a-z0-9]/g, '');

  if (FORBIDDEN_META_KEYS.includes(lower) || FORBIDDEN_META_KEYS.includes(sanitized)) {
    return true;
  }
  const substringForbiddens = [
    'secret', 'password', 'token', 'apikey', 'privatekey', 'pwd',
    'jwt', 'bearer', 'credential', 'allowlist', 'whitelist', 'superuser'
  ];
  for (const word of substringForbiddens) {
    if (lower.includes(word) || sanitized.includes(word)) {
      return true;
    }
  }
  // Compound/alternating checks
  if (
    (sanitized.includes('auth') && sanitized.includes('key')) ||
    (sanitized.includes('auth') && sanitized.includes('pass')) ||
    (sanitized.includes('pass') && sanitized.includes('key'))
  ) {
    return true;
  }

  const tokens = splitKeyIntoTokens(key);
  return tokens.some(t => FORBIDDEN_META_KEYS.includes(t));
}

function auditCodeAST(code: string): void {
  let ast: any;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (err) {
    throw new Error(`Security Exception: LifecycleSkill code failed to parse: ${(err as Error).message}`);
  }

  function walk(node: any) {
    if (!node || typeof node !== 'object') return;

    // 1. Identifier check (Finding 2 & original Identifier check)
    if (node.type === 'Identifier') {
      if (/[^\x00-\x7F]/.test(node.name)) {
        throw new Error(`Security Exception: Non-ASCII characters detected in identifier "${node.name}".`);
      }
      if (isForbiddenCredential(node.name)) {
        throw new Error(`Security Exception: Rejected skill registration: skill source code contains forbidden identifier "${node.name}".`);
      }
    }

    if (node.type === 'PrivateIdentifier') {
      if (/[^\x00-\x7F]/.test(node.name)) {
        throw new Error(`Security Exception: Non-ASCII characters detected in private identifier "${node.name}".`);
      }
      const stripped = node.name.startsWith('#') ? node.name.slice(1) : node.name;
      if (isForbiddenCredential(node.name) || isForbiddenCredential(stripped)) {
        throw new Error(`Security Exception: Rejected skill registration: skill source code contains forbidden identifier "${node.name}".`);
      }
    }

    // 2. Standard String Literals (Finding 5)
    if (node.type === 'Literal') {
      if (typeof node.value === 'string') {
        if (isForbiddenCredential(node.value)) {
          throw new Error(`Security Exception: Rejected skill registration: skill source code contains forbidden credential "${node.value}".`);
        }
      }
    }

    // 3. TemplateElement Check (Finding 5)
    if (node.type === 'TemplateElement') {
      if (node.value) {
        const cooked = node.value.cooked;
        const raw = node.value.raw;
        if (typeof cooked === 'string' && isForbiddenCredential(cooked)) {
          throw new Error(`Security Exception: Rejected skill registration: skill source code contains forbidden credential in template element.`);
        }
        if (typeof raw === 'string' && isForbiddenCredential(raw)) {
          throw new Error(`Security Exception: Rejected skill registration: skill source code contains forbidden credential in template element.`);
        }
      }
    }

    // 4. Class Field/Method & Property AST Check (Finding 2 & 3)
    if (
      node.type === 'Property' ||
      node.type === 'PropertyDefinition' ||
      node.type === 'MethodDefinition' ||
      node.type === 'ClassProperty'
    ) {
      if (node.key) {
        if (node.key.type === 'Literal' && typeof node.key.value === 'string') {
          if (/[^\x00-\x7F]/.test(node.key.value)) {
            throw new Error(`Security Exception: Non-ASCII characters detected in key literal.`);
          }
          if (isForbiddenCredential(node.key.value)) {
            throw new Error(`Security Exception: Rejected skill registration: skill source code contains forbidden property key "${node.key.value}".`);
          }
        }
      }
    }

    // 5. Computed Member/Property Expression Check (Finding 4)
    if (
      (node.type === 'MemberExpression' ||
       node.type === 'Property' ||
       node.type === 'PropertyDefinition' ||
       node.type === 'MethodDefinition' ||
       node.type === 'ClassProperty') &&
      node.computed === true
    ) {
      const computedNode = node.type === 'MemberExpression' ? node.property : node.key;
      if (!computedNode) {
        throw new Error("Security Exception: Missing computed node.");
      }
      if (computedNode.type === 'Literal') {
        const val = computedNode.value;
        if (typeof val === 'string') {
          if (/[^\x00-\x7F]/.test(val)) {
            throw new Error(`Security Exception: Non-ASCII characters detected in computed literal.`);
          }
          if (isForbiddenCredential(val)) {
            throw new Error(`Security Exception: Rejected skill registration: skill source code contains forbidden property key "${val}".`);
          }
        }
      } else if (computedNode.type === 'Identifier') {
        if (/[^\x00-\x7F]/.test(computedNode.name)) {
          throw new Error(`Security Exception: Non-ASCII characters detected in computed identifier.`);
        }
        if (isForbiddenCredential(computedNode.name)) {
          throw new Error(`Security Exception: Rejected skill registration: skill source code contains forbidden identifier "${computedNode.name}".`);
        }
      } else if (
        computedNode.type === 'TemplateLiteral' &&
        computedNode.expressions &&
        computedNode.expressions.length === 0
      ) {
        const quasi = computedNode.quasis && computedNode.quasis[0];
        if (quasi && quasi.value) {
          const val = quasi.value.cooked || quasi.value.raw;
          if (val) {
            if (/[^\x00-\x7F]/.test(val)) {
              throw new Error(`Security Exception: Non-ASCII characters detected in computed template.`);
            }
            if (isForbiddenCredential(val)) {
              throw new Error(`Security Exception: Rejected skill registration: skill source code contains forbidden property key in computed template.`);
            }
          }
        }
      } else {
        throw new Error("Security Exception: Dynamic computed property bypass risk rejected.");
      }
    }

    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          walk(item);
        }
      } else if (child && typeof child === 'object') {
        walk(child);
      }
    }
  }

  walk(ast);
}


export const VALID_TRANSITIONS: Record<SkillStage, SkillStage[]> = {
  'provenance': ['quarantine', 'versioned', 'deprecated'],
  'quarantine': ['versioned', 'deprecated'],
  'versioned': ['success-delta', 'deprecated'],
  'success-delta': ['versioned', 'deprecated'],
  'deprecated': [] // Terminal state: no outbound transitions
};

export class SkillStateMachine {
  /**
   * Attempts to transition a skill to a target stage.
   * Throws an error if the transition violates the lifecycle policy.
   */
  static transition(skill: LifecycleSkill, targetStage: SkillStage): void {
    const current = skill.stage;
    if (current === targetStage) {
      return; // Idempotency
    }

    const allowed = VALID_TRANSITIONS[current];
    if (!allowed || !allowed.includes(targetStage)) {
      throw new Error(`State Machine Exception: Transition from "${current}" to "${targetStage}" is prohibited.`);
    }

    skill.stage = targetStage;
  }
}

export class SkillLifecycleManager {
  #skills: Map<string, LifecycleSkill> = new Map();
  #observabilityService: ContourObservabilityService;

  constructor(observabilityService: IObservabilityService) {
    this.#observabilityService = observabilityService;
    
    // Register listener for automated trust-drift detection (R2)
    this.#observabilityService.registerListener((skillId, rate) => {
      this.handleSuccessRateUpdate(skillId, rate);
    });
  }

  /**
   * Registers a skill, enforces strict security scanning, and forces it to start in 'quarantine'.
   */
  registerSkill(skill: LifecycleSkill): void {
    if (!skill) {
      throw new Error("Invalid skill: LifecycleSkill is required.");
    }

    // Deep clone the incoming skill to prevent post-registration modifications.
    // Also, handle cases where tags/meta might be undefined (Finding 7).
    const cloned = JSON.parse(JSON.stringify(skill));
    isolatePrototypes(cloned);
    cloned.tags = Object.prototype.hasOwnProperty.call(cloned, 'tags') ? cloned.tags : [];
    cloned.meta = Object.prototype.hasOwnProperty.call(cloned, 'meta') ? cloned.meta : {};
    cloned.memoryBindingId = Object.prototype.hasOwnProperty.call(cloned, 'memoryBindingId') ? cloned.memoryBindingId : undefined;
    cloned.successDelta = Object.prototype.hasOwnProperty.call(cloned, 'successDelta') ? cloned.successDelta : undefined;

    if (!cloned.id) {
      throw new Error("Invalid skill: Missing ID.");
    }
    if (this.#skills.has(cloned.id)) {
      throw new Error(`LifecycleSkill "${cloned.id}" is already registered.`);
    }

    // Validate versioning and provenance fields
    if (typeof cloned.version !== 'string' || !cloned.version.trim()) {
      throw new Error("Invalid skill: Missing or invalid version.");
    }
    if (cloned.provenance !== 'human' && cloned.provenance !== 'system' && cloned.provenance !== 'internet') {
      throw new Error("Invalid skill: Missing or invalid provenance.");
    }
    if (typeof cloned.validatedModel !== 'string' || !cloned.validatedModel.trim()) {
      throw new Error("Invalid skill: Missing or invalid validatedModel.");
    }
    if (typeof cloned.validatedEnv !== 'string' || !cloned.validatedEnv.trim()) {
      throw new Error("Invalid skill: Missing or invalid validatedEnv.");
    }
    if (cloned.memoryBindingId !== undefined && (typeof cloned.memoryBindingId !== 'string' || !cloned.memoryBindingId.trim())) {
      throw new Error("Invalid skill: Invalid memoryBindingId.");
    }

    // Security Verification (R3): Reject forbidden patterns
    this.validateSkillSecurity(cloned);

    // Initial quarantine assignment (R4) unless registered with stage 'provenance'
    const registeredSkill: LifecycleSkill = {
      ...cloned,
      stage: cloned.stage === 'provenance' ? 'provenance' : 'quarantine',
      successDelta: cloned.successDelta ?? 1.0,
    };

    isolatePrototypes(registeredSkill);
    // Deep freeze the registered skill recursively (Finding 1)
    deepFreeze(registeredSkill);

    this.#skills.set(registeredSkill.id, registeredSkill);
  }

  /**
   * Performs state transitions following strict progression rules.
   */
  transitionTo(skillId: string, targetStage: SkillStage): void {
    const skill = this.#skills.get(skillId);
    if (!skill) {
      throw new Error(`LifecycleSkill "${skillId}" is not registered.`);
    }

    let finalTarget = targetStage;
    if (targetStage === 'success-delta' && skill.successDelta < 0.8) {
      finalTarget = 'deprecated';
    }

    // Since skill is frozen, clone it before transitioning
    const clonedSkill = JSON.parse(JSON.stringify(skill));
    isolatePrototypes(clonedSkill);
    SkillStateMachine.transition(clonedSkill, finalTarget);

    deepFreeze(clonedSkill);
    this.#skills.set(skillId, clonedSkill);
  }

  /**
   * Executes the skill subject to Human Admission gates.
   */
  async executeSkill(skillId: string, bypassHumanGate: boolean, isGoldenSet: boolean): Promise<any> {
    let skill = this.#skills.get(skillId);
    if (!skill) {
      throw new Error(`LifecycleSkill "${skillId}" not found.`);
    }

    if (skill.stage === 'deprecated') {
      throw new Error(`Execution Denied: LifecycleSkill "${skillId}" is deprecated.`);
    }

    // Human Gate Admission rules (R4)
    if (skill.stage === 'quarantine' || skill.stage === 'provenance') {
      if (!bypassHumanGate && !isGoldenSet) {
        throw new RequiresHumanAdmission(skillId);
      }
      
      // Check immediately before evaluating
      skill = this.#skills.get(skillId);
      if (!skill || skill.stage === 'deprecated') {
        throw new Error(`Execution Denied: LifecycleSkill "${skillId}" is deprecated.`);
      }

      const result = await this.evaluateSkillCode(skill, bypassHumanGate, isGoldenSet);
      
      // Check if the skill has been deprecated immediately after the evaluateSkillCode promise resolves
      skill = this.#skills.get(skillId);
      if (!skill || skill.stage === 'deprecated') {
        throw new Error(`Execution Denied: LifecycleSkill "${skillId}" is deprecated.`);
      }

      // Auto promote to versioned
      this.transitionTo(skillId, 'versioned');

      // Check again after any transition step
      skill = this.#skills.get(skillId);
      if (!skill || skill.stage === 'deprecated') {
        throw new Error(`Execution Denied: LifecycleSkill "${skillId}" is deprecated.`);
      }
      
      return result;
    }

    // If versioned and executed in production, transition to success-delta monitoring
    if (skill.stage === 'versioned') {
      this.transitionTo(skillId, 'success-delta');

      // Check again after any transition step
      skill = this.#skills.get(skillId);
      if (!skill || skill.stage === 'deprecated') {
        throw new Error(`Execution Denied: LifecycleSkill "${skillId}" is deprecated.`);
      }
    }

    // Check immediately before evaluating/executing the skill's code block
    skill = this.#skills.get(skillId);
    if (!skill || skill.stage === 'deprecated') {
      throw new Error(`Execution Denied: LifecycleSkill "${skillId}" is deprecated.`);
    }

    const result = await this.evaluateSkillCode(skill, bypassHumanGate, isGoldenSet);

    // Check if the skill has been deprecated immediately after the evaluateSkillCode promise resolves
    skill = this.#skills.get(skillId);
    if (!skill || skill.stage === 'deprecated') {
      throw new Error(`Execution Denied: LifecycleSkill "${skillId}" is deprecated.`);
    }

    return result;
  }

  /**
   * Permitted skills assignment gateway based on task tags.
   */
  getPermittedSkills(taskTags: string[]): Set<string> {
    const permitted = new Set<string>();
    
    const safeTaskTags: string[] = [];
    if (taskTags) {
      for (let i = 0; i < taskTags.length; i++) {
        const t = taskTags[i];
        if (typeof t === 'string') {
          safeTaskTags.push(t);
        }
      }
    }

    for (const [skillId, skill] of this.#skills.entries()) {
      // Deprecated skills are never selectable or assignable
      if (skill.stage === 'deprecated') {
        continue;
      }

      // Quarantined/unverified skills cannot be assigned to normal production flows
      if (skill.stage === 'quarantine' || skill.stage === 'provenance') {
        continue;
      }

      // Zone-Gate Check: LifecycleSkill tags must be a subset of the task's active tags.
      const safeSkillTags: string[] = [];
      const skillTags = skill.tags;
      if (skillTags) {
        for (let i = 0; i < skillTags.length; i++) {
          const t = skillTags[i];
          if (typeof t === 'string') {
            safeSkillTags.push(t);
          }
        }
      }

      let hasAllTags = true;
      for (let i = 0; i < safeSkillTags.length; i++) {
        const tag = safeSkillTags[i];
        let found = false;
        for (let j = 0; j < safeTaskTags.length; j++) {
          if (safeTaskTags[j] === tag) {
            found = true;
            break;
          }
        }
        if (!found) {
          hasAllTags = false;
          break;
        }
      }

      if (hasAllTags) {
        permitted.add(skillId);
      }
    }

    return permitted;
  }

  getUnverifiedSkillsForTask(taskTags: string[]): LifecycleSkill[] {
    const unverified: LifecycleSkill[] = [];
    
    const safeTaskTags: string[] = [];
    if (taskTags) {
      for (let i = 0; i < taskTags.length; i++) {
        const t = taskTags[i];
        if (typeof t === 'string') {
          safeTaskTags.push(t);
        }
      }
    }

    for (const skill of this.#skills.values()) {
      if (skill.stage === 'quarantine' || skill.stage === 'provenance') {
        const safeSkillTags: string[] = [];
        const skillTags = skill.tags;
        if (skillTags) {
          for (let i = 0; i < skillTags.length; i++) {
            const t = skillTags[i];
            if (typeof t === 'string') {
              safeSkillTags.push(t);
            }
          }
        }

        let isSubset = true;
        for (let i = 0; i < safeSkillTags.length; i++) {
          const tag = safeSkillTags[i];
          let found = false;
          for (let j = 0; j < safeTaskTags.length; j++) {
            if (safeTaskTags[j] === tag) {
              found = true;
              break;
            }
          }
          if (!found) {
            isSubset = false;
            break;
          }
        }

        if (isSubset) {
          const cloned = JSON.parse(JSON.stringify(skill));
          isolatePrototypes(cloned);
          cloned.tags = Object.prototype.hasOwnProperty.call(cloned, 'tags') ? cloned.tags : [];
          cloned.meta = Object.prototype.hasOwnProperty.call(cloned, 'meta') ? cloned.meta : {};
          cloned.memoryBindingId = Object.prototype.hasOwnProperty.call(cloned, 'memoryBindingId') ? cloned.memoryBindingId : undefined;
          cloned.successDelta = Object.prototype.hasOwnProperty.call(cloned, 'successDelta') ? cloned.successDelta : undefined;
          unverified.push(deepFreeze(cloned));
        }
      }
    }

    return unverified;
  }

  offerVerification(skillId: string): { offerId: string; prompt: string; runGoldenSet: () => Promise<any> } {
    const skill = this.#skills.get(skillId);
    if (!skill) {
      throw new Error(`LifecycleSkill "${skillId}" is not registered.`);
    }
    if (skill.stage === 'deprecated') {
      throw new Error(`Verification Denied: LifecycleSkill "${skillId}" is deprecated.`);
    }

    const offerId = `offer-${Math.random().toString(36).substr(2, 9)}`;
    const prompt = `Verify skill ${skillId} with golden set.`;

    const runGoldenSet = async () => {
      const currentSkill = this.#skills.get(skillId);
      if (!currentSkill) {
        throw new Error(`LifecycleSkill "${skillId}" not found for verification.`);
      }
      if (currentSkill.stage === 'deprecated') {
        throw new Error(`Verification Denied: LifecycleSkill "${skillId}" is deprecated.`);
      }

      const result = await this.evaluateSkillCode(currentSkill, false, true);
      this.transitionTo(skillId, 'versioned');
      return result;
    };

    return {
      offerId,
      prompt,
      runGoldenSet
    };
  }

  /**
   * Accessor for testing state assertions.
   */
  getSkill(skillId: string): LifecycleSkill | undefined {
    const skill = this.#skills.get(skillId);
    if (!skill) return undefined;
    const cloned = JSON.parse(JSON.stringify(skill));
    isolatePrototypes(cloned);
    cloned.tags = Object.prototype.hasOwnProperty.call(cloned, 'tags') ? cloned.tags : [];
    cloned.meta = Object.prototype.hasOwnProperty.call(cloned, 'meta') ? cloned.meta : {};
    cloned.memoryBindingId = Object.prototype.hasOwnProperty.call(cloned, 'memoryBindingId') ? cloned.memoryBindingId : undefined;
    cloned.successDelta = Object.prototype.hasOwnProperty.call(cloned, 'successDelta') ? cloned.successDelta : undefined;
    return deepFreeze(cloned);
  }

  // Alias for getSkill to support multiple explorer test suites
  getSkillState(skillId: string): LifecycleSkill | undefined {
    return this.getSkill(skillId);
  }

  /**
   * R3 Guard: Validates that skill does not carry tokens or expand allow-lists.
   */
  private validateSkillSecurity(skill: LifecycleSkill): void {
    // 1. Audit Meta and Custom Parameters
    const checkMetadata = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [key, value] of Object.entries(obj)) {
        if (/[^\x00-\x7F]/.test(key)) {
          throw new Error(`Security Exception: Non-ASCII characters detected in metadata key "${key}".`);
        }
        if (isForbiddenMetaKey(key)) {
          throw new Error(`Security Exception: Rejected skill registration: meta contains restricted security parameter key "${key}".`);
        }

        if (typeof value === 'string') {
          // Detect JWT pattern: header.payload.signature
          if (/^[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+$/.test(value)) {
            throw new Error(`Security Exception: Rejected skill registration: metadata value for key '${key}' contains a hardcoded JWT.`);
          }
          // Detect Bearer token patterns
          if (/bearer\s*[:\s]\s*[a-zA-Z0-9_\-\.]+/i.test(value)) {
            throw new Error(`Security Exception: Rejected skill registration: metadata value for key '${key}' contains a Bearer token.`);
          }
        }
        
        // Check boolean privilege flags
        const lowerKey = key.toLowerCase();
        if ((value === true || value === 'true') && ['bypassgate', 'bypasshumangate', 'expandallowlist'].includes(lowerKey)) {
          throw new Error(`Security Exception: Rejected skill registration: forbidden permission expansion flag '${key}' set to true.`);
        }

        if (typeof value === 'object') {
          checkMetadata(value);
        }
      }
    };
    
    checkMetadata(skill.meta);

    // 2. Audit Code for Embedded Credentials via AST
    if (skill.code) {
      auditCodeAST(skill.code);
    }

    // 3. Forbid allow-list expansions in tags
    const forbiddenTags = ['*', 'sudo', 'root', 'allow-all', 'allow_all', 'bypass', 'bypass-gate', 'bypass_gate', 'admin', 'superuser'];
    const tags = skill.tags || [];
    for (const tag of tags) {
      // Prevent homoglyph bypasses: enforce strict tag regex check (e.g. /^[a-zA-Z0-9_\-:]+$/)
      if (!/^[a-zA-Z0-9_\-:]+$/.test(tag)) {
        throw new Error(`Security Exception: Rejected skill registration: tag '${tag}' contains invalid characters or homoglyphs.`);
      }

      const lowerTag = tag.toLowerCase();
      if (
        forbiddenTags.some(ft => lowerTag === ft || lowerTag.includes(ft)) ||
        lowerTag.includes('*') ||
        lowerTag.includes('allowlist') ||
        lowerTag.includes('whitelist') ||
        lowerTag.includes('permission')
      ) {
        throw new Error(`Security Exception: Rejected skill registration: tag '${tag}' attempts privilege escalation or allow-list expansion.`);
      }
    }
  }

  /**
   * R2: Trust-Drift Integration callback.
   * If a monitored skill's success rate falls below 80% (0.80), transition to deprecated.
   */
  private handleSuccessRateUpdate(skillId: string, rate: number): void {
    if (typeof rate !== 'number' || Number.isNaN(rate)) {
      throw new Error("Rate must be a valid number.");
    }
    if (rate < 0 || rate > 1) {
      throw new Error("Rate must be a decimal value between 0.0 and 1.0.");
    }

    const skill = this.#skills.get(skillId);
    if (!skill) return;

    // Clone the skill because it is frozen
    const skillClone = JSON.parse(JSON.stringify(skill));
    skillClone.successDelta = rate;

    // Save the clone to the map first
    deepFreeze(skillClone);
    this.#skills.set(skillId, skillClone);

    // Monitor success-delta stage for automated retirement
    if (skillClone.stage === 'success-delta' && rate < 0.8) {
      this.transitionTo(skillId, 'deprecated');
    }
  }

  // Simulated code sandbox execution
  private async evaluateSkillCode(skill: LifecycleSkill, bypassHumanGate: boolean, isGoldenSet: boolean): Promise<any> {
    return {
      success: true,
      status: 'executed',
      executedSkillId: skill.id,
      skillId: skill.id,
      stage: skill.stage,
      bypassHumanGate,
      isGoldenSet,
      executedAt: new Date().toISOString()
    };
  }
}

export const skillLifecycleManager = new SkillLifecycleManager(contourObservability);
