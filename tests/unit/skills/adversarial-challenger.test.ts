import { MockContourObservabilityService } from './mock-observability';
import { describe, test, expect, beforeEach } from 'vitest';
import { 
  SkillLifecycleManager, 
  LifecycleSkill,
  RequiresHumanAdmission,
  VALID_TRANSITIONS
} from '../../../server/pipeline/skills/skill-lifecycle-manager';

describe('Empirical Challenger - Adversarial Stress Tests', () => {
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

  describe('1. Private Identifier Unicode / Cyrillic Bypasses', () => {
    test('Should block private field with Cyrillic characters directly in code', () => {
      const skill: LifecycleSkill = {
        id: 'adv-private-cyrillic-1',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'class C { #секрет = "val"; }', // Cyrillic 'секрет'
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/Security Exception: Non-ASCII characters detected in private identifier/);
    });

    test('Should block private field with Unicode escape sequences for Cyrillic', () => {
      const skill: LifecycleSkill = {
        id: 'adv-private-cyrillic-2',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'class C { #p\\u0430ssword = "val"; }', // Unicode escape for Cyrillic 'а'
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/Security Exception: Non-ASCII characters detected in private identifier/);
    });

    test('Should block private field with other non-ASCII Unicode (e.g., Greek pi)', () => {
      const skill: LifecycleSkill = {
        id: 'adv-private-greek',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'class C { #\\u03c0 = 3.14; }', // Unicode escape for Greek 'π'
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/Security Exception: Non-ASCII characters detected in private identifier/);
    });

    test('Should block private identifier in member access expressions', () => {
      const skill: LifecycleSkill = {
        id: 'adv-private-member',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'class C { #p\\u0430ssword = 1; check() { return this.#p\\u0430ssword; } }',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/Security Exception: Non-ASCII characters detected in private identifier/);
    });
  });

  describe('2. Prototype Chain Infection Bypasses', () => {
    test('Prototype pollution of Array.prototype.includes and String.prototype.includes can bypass credential checking', () => {
      const originalIncludes = Array.prototype.includes;
      const originalStringIncludes = String.prototype.includes;
      try {
        // Pollute Array.prototype.includes to return false for forbidden credentials
        Array.prototype.includes = function(searchElement: any) {
          if (typeof searchElement === 'string' && originalIncludes.call(['secret', 'password', 'token'], searchElement)) {
            return false;
          }
          return originalIncludes.apply(this, arguments as any);
        };

        // Pollute String.prototype.includes to return false for forbidden credentials
        String.prototype.includes = function(searchString: any) {
          if (typeof searchString === 'string' && originalIncludes.call(['secret', 'password', 'token'], searchString)) {
            return false;
          }
          return originalStringIncludes.apply(this, arguments as any);
        };

        // This skill contains forbidden credential 'password' in both code and meta
        const skill: LifecycleSkill = {
          id: 'adv-proto-polluted-1',
          stage: 'quarantine',
          successDelta: 1.0,
          tags: [],
          code: 'const password = "my-password";',
          meta: {
            password: 'my-password'
          },
          ...validBaseSkillProps
        };

        // If the bypass works, it will register successfully instead of throwing!
        expect(() => manager.registerSkill(skill)).not.toThrow();
        expect(manager.getSkill('adv-proto-polluted-1')).toBeDefined();
      } finally {
        Array.prototype.includes = originalIncludes;
        String.prototype.includes = originalStringIncludes;
      }
    });

    test('Prototype pollution of Array.prototype.some can bypass compound credential checking', () => {
      const originalSome = Array.prototype.some;
      try {
        Array.prototype.some = function() {
          return false;
        };

        const skill: LifecycleSkill = {
          id: 'adv-proto-polluted-2',
          stage: 'quarantine',
          successDelta: 1.0,
          tags: [],
          code: 'const my_auth = "val";',
          meta: {
            my_auth: 'val'
          },
          ...validBaseSkillProps
        };

        expect(() => manager.registerSkill(skill)).not.toThrow();
        expect(manager.getSkill('adv-proto-polluted-2')).toBeDefined();
      } finally {
        Array.prototype.some = originalSome;
      }
    });

    test('Modifying VALID_TRANSITIONS directly allows illegal state transitions', () => {
      // VALID_TRANSITIONS is mutable and not frozen.
      // Let's modify it to allow transitioning from deprecated to quarantine.
      const originalTransitions = [...VALID_TRANSITIONS['deprecated']];
      try {
        VALID_TRANSITIONS['deprecated'].push('quarantine');

        const skill: LifecycleSkill = {
          id: 'adv-lifecycle-bypass',
          stage: 'quarantine',
          successDelta: 1.0,
          tags: [],
          code: 'console.log("lifecycle bypass");',
          meta: {},
          ...validBaseSkillProps
        };

        manager.registerSkill(skill);
        // Transition to deprecated
        manager.transitionTo('adv-lifecycle-bypass', 'deprecated');
        expect(manager.getSkill('adv-lifecycle-bypass')?.stage).toBe('deprecated');

        // Now transition back to quarantine should be allowed due to modification
        expect(() => manager.transitionTo('adv-lifecycle-bypass', 'quarantine')).not.toThrow();
        expect(manager.getSkill('adv-lifecycle-bypass')?.stage).toBe('quarantine');
      } finally {
        VALID_TRANSITIONS['deprecated'] = originalTransitions;
      }
    });
  });

  describe('3. Credential Key Variation Bypasses', () => {
    test('Should block "pass_key" variation in metadata', () => {
      const skill: LifecycleSkill = {
        id: 'adv-cred-passkey',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {
          pass_key: 'secret'
        },
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/meta contains restricted security parameter key/);
    });

    test('Should block "authKey" variation in metadata', () => {
      const skill: LifecycleSkill = {
        id: 'adv-cred-authkey',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {
          authKey: 'secret'
        },
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/meta contains restricted security parameter key/);
    });

    test('Should block "key-auth" variation in metadata', () => {
      const skill: LifecycleSkill = {
        id: 'adv-cred-keyauth',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {
          'key-auth': 'secret'
        },
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/meta contains restricted security parameter key/);
    });

    test('Should block "allow_list" variation in metadata', () => {
      const skill: LifecycleSkill = {
        id: 'adv-cred-allowlist',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {
          allow_list: 'restricted'
        },
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/meta contains restricted security parameter key/);
    });

    test('Should block "expand_allow_list" variation in metadata', () => {
      const skill: LifecycleSkill = {
        id: 'adv-cred-expandallowlist',
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

    test('Bypass demonstration: key1 and mykey are NOT blocked because key is not in substringForbiddens', () => {
      const skill1: LifecycleSkill = {
        id: 'adv-cred-bypass-key1',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const key1 = "val";',
        meta: {
          key1: 'val'
        },
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill1)).not.toThrow();

      const skill2: LifecycleSkill = {
        id: 'adv-cred-bypass-mykey',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const mykey = "val";',
        meta: {
          mykey: 'val'
        },
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill2)).not.toThrow();
    });

    test('Bypass demonstration: p@ssword and pa$$word in string literal or metadata bypass filters', () => {
      const skill1: LifecycleSkill = {
        id: 'adv-cred-bypass-leetspeak-literal',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const x = "p@ssword";',
        meta: {
          'p@ssword': 'val'
        },
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill1)).not.toThrow();

      const skill2: LifecycleSkill = {
        id: 'adv-cred-bypass-leetspeak-ident',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const pa$$word = "val";',
        meta: {
          'pa$$word': 'val'
        },
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill2)).not.toThrow();
    });
  });
});
