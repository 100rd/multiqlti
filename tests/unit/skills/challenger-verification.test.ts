import { MockContourObservabilityService } from './mock-observability';
import { describe, test, expect, beforeEach } from 'vitest';
import { 
  SkillLifecycleManager, 
  LifecycleSkill,
  RequiresHumanAdmission
} from '../../../server/pipeline/skills/skill-lifecycle-manager';

describe('Adversarial Challenger Verification Tests', () => {
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

  describe('1. PrivateIdentifier Unicode/Homoglyph Bypass', () => {
    test('Should block skill with private field containing Cyrillic homoglyph in name', () => {
      // Cyrillic 'а' (U+0430) is used instead of Latin 'a' in '#password' -> '#pаssword'
      const skill: LifecycleSkill = {
        id: 'ast-adv-private-field-homoglyph',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'class MyClass { #pаssword = "123"; }',
        meta: {},
        ...validBaseSkillProps
      };
      
      expect(() => manager.registerSkill(skill)).toThrow(/Non-ASCII characters detected in private identifier/);
    });

    test('Should block skill with private method containing Cyrillic homoglyph in name', () => {
      const skill: LifecycleSkill = {
        id: 'ast-adv-private-method-homoglyph',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'class MyClass { #pаssword() { return "123"; } }',
        meta: {},
        ...validBaseSkillProps
      };
      
      expect(() => manager.registerSkill(skill)).toThrow(/Non-ASCII characters detected in private identifier/);
    });
  });

  describe('2. Object Prototype Pollution Validation Bypasses', () => {
    test('Should reject skill registration with missing fields even when Object.prototype is polluted', () => {
      const proto = Object.prototype as any;
      proto.version = '1.0.0';
      proto.provenance = 'human';
      proto.validatedModel = 'gpt-4';
      proto.validatedEnv = 'test';
      proto.code = 'console.log("polluted code");';

      try {
        // LifecycleSkill missing almost all required properties!
        const skill = {
          id: 'proto-pollution-bypass-skill',
          stage: 'quarantine',
          // version, provenance, validatedModel, validatedEnv, code are all missing!
        } as unknown as LifecycleSkill;

        expect(() => manager.registerSkill(skill)).toThrow(/Invalid skill: Missing or invalid version/);
      } finally {
        delete proto.version;
        delete proto.provenance;
        delete proto.validatedModel;
        delete proto.validatedEnv;
        delete proto.code;
      }
    });
  });

  describe('3. Metadata key and Alternating Cases Bypasses', () => {
    test('Should block "pass_word" in metadata', () => {
      const skill: LifecycleSkill = {
        id: 'meta-pass-word',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {
          pass_word: 'my-secret'
        },
        ...validBaseSkillProps
      };
      
      expect(() => manager.registerSkill(skill)).toThrow(/meta contains restricted security parameter key/);
    });

    test('Should block "allow_list" in metadata', () => {
      const skill: LifecycleSkill = {
        id: 'meta-allow-list',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {
          allow_list: 'my-allowlist'
        },
        ...validBaseSkillProps
      };
      
      expect(() => manager.registerSkill(skill)).toThrow(/meta contains restricted security parameter key/);
    });

    test('Should block "super_user" in metadata', () => {
      const skill: LifecycleSkill = {
        id: 'meta-super-user',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {
          super_user: 'admin'
        },
        ...validBaseSkillProps
      };
      
      expect(() => manager.registerSkill(skill)).toThrow(/meta contains restricted security parameter key/);
    });

    test('Should block "expand_allow_list" with boolean true in metadata', () => {
      const skill: LifecycleSkill = {
        id: 'meta-expand-allow-list',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {
          expand_allow_list: true
        },
        ...validBaseSkillProps
      };
      
      expect(() => manager.registerSkill(skill)).toThrow(/meta contains restricted security parameter key/);
    });
  });
});
