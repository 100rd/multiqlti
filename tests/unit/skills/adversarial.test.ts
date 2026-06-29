import { MockContourObservabilityService } from './mock-observability';
import { describe, test, expect, beforeEach } from 'vitest';
import { 
  SkillLifecycleManager, 
  LifecycleSkill,
  RequiresHumanAdmission
} from '../../../server/pipeline/skills/skill-lifecycle-manager';

describe('Adversarial Testing for SPEC-11 Remediation', () => {
  let obsService: MockContourObservabilityService;
  let manager: SkillLifecycleManager;

  const validBaseSkillProps = {
    version: '1.0.0',
    provenance: 'human' as const,
    validatedModel: 'gpt-4',
    validatedEnv: 'test'
  };

  beforeEach(() => {
    obsService = new MockContourObservabilityService();
    manager = new SkillLifecycleManager(obsService);
  });

  describe('Out-of-order transitions', () => {
    test('Should block direct transitions from quarantine to success-delta', () => {
      const skill: LifecycleSkill = {
        id: 'transition-adv-1',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("transition test");',
        meta: {},
        ...validBaseSkillProps
      };
      manager.registerSkill(skill);

      expect(() => manager.transitionTo('transition-adv-1', 'success-delta')).toThrow(/Transition from "quarantine" to "success-delta" is prohibited/);
    });

    test('Should block transition from deprecated back to quarantine or versioned', () => {
      const skill: LifecycleSkill = {
        id: 'transition-adv-2',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("transition test 2");',
        meta: {},
        ...validBaseSkillProps
      };
      manager.registerSkill(skill);
      manager.transitionTo('transition-adv-2', 'deprecated');

      expect(() => manager.transitionTo('transition-adv-2', 'quarantine')).toThrow(/Transition from "deprecated" to "quarantine" is prohibited/);
      expect(() => manager.transitionTo('transition-adv-2', 'versioned')).toThrow(/Transition from "deprecated" to "versioned" is prohibited/);
    });
  });

  describe('Cyrillic tag homoglyphs & invalid tags', () => {
    test('Should reject Cyrillic homoglyph tags', () => {
      const skill: LifecycleSkill = {
        id: 'tag-adv-1',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: ['zone:grееn'], // Cyrillic 'е'
        code: 'console.log("tag test");',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/contains invalid characters or homoglyphs/);
    });

    test('Should reject other non-ASCII tags', () => {
      const skill: LifecycleSkill = {
        id: 'tag-adv-2',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: ['zone:gяeen'], // Cyrillic 'я'
        code: 'console.log("tag test");',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/contains invalid characters or homoglyphs/);
    });

    test('Should reject wildcard/allowlist tags', () => {
      const skill: LifecycleSkill = {
        id: 'tag-adv-3',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: ['allowlist:bypass'],
        code: 'console.log("tag test");',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/attempts privilege escalation or allow-list expansion/);
    });
  });

  describe('NaN and invalid rate metrics', () => {
    test('Should block NaN rate in observability tracking', () => {
      expect(() => obsService.trackSkillSuccessRate('some-skill', NaN)).toThrow(/Rate must be a valid number/);
    });

    test('Should block out-of-range rates', () => {
      expect(() => obsService.trackSkillSuccessRate('some-skill', 1.1)).toThrow(/Rate must be a decimal value/);
      expect(() => obsService.trackSkillSuccessRate('some-skill', -0.1)).toThrow(/Rate must be a decimal value/);
    });
  });

  describe('Metadata key false positives & valid permissions', () => {
    test('Should allow keyboardLayout without false positives', () => {
      const skill: LifecycleSkill = {
        id: 'meta-adv-1',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("meta test");',
        meta: {
          keyboardLayout: 'us'
        },
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).not.toThrow();
    });

    test('Should block true value of bypassGate in meta keys (case-insensitive)', () => {
      const skill: LifecycleSkill = {
        id: 'meta-adv-2',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("meta test");',
        meta: {
          bypassgate: true
        },
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/forbidden permission expansion flag 'bypassgate' set to true/);
    });
  });

  describe('AST code audits - destructuring, comments, member assignments', () => {
    test('Should reject destructuring with rename alias', () => {
      const skill: LifecycleSkill = {
        id: 'ast-adv-1',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const { api: secret } = someObj;',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/forbidden identifier "secret"/);
    });

    test('Should reject rest elements containing credentials', () => {
      const skill: LifecycleSkill = {
        id: 'ast-adv-2',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const { ...secret } = someObj;',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/forbidden identifier "secret"/);
    });

    test('Should REJECT function parameter with forbidden credential name', () => {
      const skill: LifecycleSkill = {
        id: 'ast-adv-3',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'function login(password) { return true; }',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/contains forbidden identifier "password"/);
    });

    test('Should REJECT function parameter default assignment with forbidden credential name', () => {
      const skill: LifecycleSkill = {
        id: 'ast-adv-4',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'function login(password = "secret_val") { return true; }',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/contains forbidden identifier "password"/);
    });

    test('Should REJECT global member assignment with literal string key', () => {
      const skill: LifecycleSkill = {
        id: 'ast-adv-5',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'globalThis["secret"] = "my-secret";',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/contains forbidden property key "secret"/);
    });

    test('Should REJECT class field definition with forbidden credential name', () => {
      const skill: LifecycleSkill = {
        id: 'ast-adv-6',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'class MyClass { password = "123"; }',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/contains forbidden identifier "password"/);
    });

    test('Should REJECT computed property destructuring declaration with forbidden credential name (BLOCKED)', () => {
      const skill: LifecycleSkill = {
        id: 'ast-adv-7',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const { ["secret"]: myVal } = obj;',
        meta: {},
        ...validBaseSkillProps
      };
      // Correctly blocked!
      expect(() => manager.registerSkill(skill)).toThrow(/forbidden property key "secret"/);
    });
  });
});
