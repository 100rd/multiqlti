import { MockContourObservabilityService } from './mock-observability';
import { describe, test, expect, beforeEach } from 'vitest';
import { 
  SkillLifecycleManager, 
  LifecycleSkill,
  RequiresHumanAdmission
} from '../../../server/pipeline/skills/skill-lifecycle-manager';

describe('SPEC-11 Quality and Security Remediation Tests', () => {
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

  describe('1. Versioning and Provenance Metadata (REQ-11-A)', () => {
    test('Should successfully register skill with valid versioning metadata', () => {
      const skill: LifecycleSkill = {
        id: 'valid-meta-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: ['zone:green'],
        code: 'console.log("hello");',
        meta: {},
        ...validBaseSkillProps
      };

      expect(() => manager.registerSkill(skill)).not.toThrow();
      const registered = manager.getSkill('valid-meta-skill');
      expect(registered).toBeDefined();
      expect(registered?.version).toBe('1.0.0');
      expect(registered?.provenance).toBe('human');
      expect(registered?.validatedModel).toBe('gpt-4');
      expect(registered?.validatedEnv).toBe('test');
    });

    test('Should reject skill registration with missing or invalid version', () => {
      const skill: any = {
        id: 'invalid-version',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {},
        version: '',
        provenance: 'human',
        validatedModel: 'gpt-4',
        validatedEnv: 'test'
      };

      expect(() => manager.registerSkill(skill)).toThrow(/Missing or invalid version/);
    });

    test('Should reject skill registration with invalid provenance', () => {
      const skill: any = {
        id: 'invalid-prov',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {},
        version: '1.0.0',
        provenance: 'alien',
        validatedModel: 'gpt-4',
        validatedEnv: 'test'
      };

      expect(() => manager.registerSkill(skill)).toThrow(/Missing or invalid provenance/);
    });

    test('Should accept optional memoryBindingId and reject if invalid', () => {
      const skillWithMem: LifecycleSkill = {
        id: 'mem-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {},
        ...validBaseSkillProps,
        memoryBindingId: 'mem-123'
      };
      expect(() => manager.registerSkill(skillWithMem)).not.toThrow();

      const skillWithInvalidMem: any = {
        id: 'invalid-mem-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {},
        ...validBaseSkillProps,
        memoryBindingId: '   '
      };
      expect(() => manager.registerSkill(skillWithInvalidMem)).toThrow(/Invalid memoryBindingId/);
    });
  });

  describe('2. Trust-Drift Bypass & Observability Validation (R2)', () => {
    test('Should transition success-delta target immediately to deprecated if successDelta < 0.8', () => {
      const skill: LifecycleSkill = {
        id: 'drift-skill',
        stage: 'quarantine',
        successDelta: 0.75, // Initial successDelta < 0.8
        tags: [],
        code: 'console.log("drift");',
        meta: {},
        ...validBaseSkillProps
      };
      manager.registerSkill(skill);

      // Quarantine -> Versioned (Valid)
      manager.transitionTo('drift-skill', 'versioned');
      expect(manager.getSkill('drift-skill')?.stage).toBe('versioned');

      // Versioned -> Success-Delta (with current rate < 0.8) should redirect to deprecated
      manager.transitionTo('drift-skill', 'success-delta');
      expect(manager.getSkill('drift-skill')?.stage).toBe('deprecated');
    });

    test('Observability trackSkillSuccessRate should throw on NaN rate', () => {
      expect(() => obsService.trackSkillSuccessRate('some-skill', NaN)).toThrow(/Rate must be a valid number/);
    });

    test('Observability trackSkillSuccessRate should throw on invalid rate types', () => {
      expect(() => obsService.trackSkillSuccessRate('some-skill', '0.5' as any)).toThrow(/Rate must be a valid number/);
    });
  });

  describe('3. Active Verification Offer (REQ-11-C)', () => {
    test('getUnverifiedSkillsForTask should filter quarantine/provenance skills by subset of task tags', () => {
      const skillA: LifecycleSkill = {
        id: 'skill-unverified-a',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: ['tag1', 'tag2'],
        code: 'console.log("A");',
        meta: {},
        ...validBaseSkillProps
      };
      const skillB: LifecycleSkill = {
        id: 'skill-unverified-b',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: ['tag2', 'tag3'],
        code: 'console.log("B");',
        meta: {},
        ...validBaseSkillProps
      };

      manager.registerSkill(skillA);
      manager.registerSkill(skillB);

      // Task tags: ['tag1', 'tag2', 'tag4']
      // skillA tags: ['tag1', 'tag2'] -> subset of task tags -> matches
      // skillB tags: ['tag2', 'tag3'] -> tag3 is missing -> no match
      const results = manager.getUnverifiedSkillsForTask(['tag1', 'tag2', 'tag4']);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('skill-unverified-a');
    });

    test('offerVerification should return prompt/offerId and runGoldenSet promotes to versioned', async () => {
      const skill: LifecycleSkill = {
        id: 'offer-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("offer");',
        meta: {},
        ...validBaseSkillProps
      };
      manager.registerSkill(skill);

      const offer = manager.offerVerification('offer-skill');
      expect(offer.offerId).toBeDefined();
      expect(offer.prompt).toContain('offer-skill');
      expect(typeof offer.runGoldenSet).toBe('function');

      const result = await offer.runGoldenSet();
      expect(result.status).toBe('executed');
      expect(result.isGoldenSet).toBe(true);

      const updated = manager.getSkill('offer-skill');
      expect(updated?.stage).toBe('versioned');
    });
  });

  describe('4. Security Regex and Homoglyph Bypasses (R3)', () => {
    test('Reject destructured variable declaration matching credentials in code', () => {
      const skill: LifecycleSkill = {
        id: 'ast-destruct-var',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const [token] = getTokens();',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/forbidden identifier "token"/);
    });

    test('Reject assignment matching credentials in code', () => {
      const skill: LifecycleSkill = {
        id: 'ast-assign',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'secret = "mySecret";',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/forbidden identifier "secret"/);
    });

    test('Reject object literal property matching credentials in code', () => {
      const skill: LifecycleSkill = {
        id: 'ast-object-prop',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const config = { "password": "123" };',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/forbidden property key "password"/);
    });

    test('Allow non-credentials keywords with camelCase splitting (author vs apiKey)', () => {
      const skillValid: LifecycleSkill = {
        id: 'camelcase-valid',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const author = "John"; const keyboardLayout = "US";',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skillValid)).not.toThrow();

      const skillInvalid: LifecycleSkill = {
        id: 'camelcase-invalid',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const apiKey = "123";',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skillInvalid)).toThrow(/forbidden identifier/);
    });

    test('Reject homoglyph bypasses in tags', () => {
      const skill: LifecycleSkill = {
        id: 'homoglyph-tag',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: ['zоnе:grееn'], // Cyrillic 'о', 'е'
        code: 'console.log("homoglyph");',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/tag '.*' contains invalid characters or homoglyphs/);
    });

    test('getSkill and getSkillState return frozen deep clones', () => {
      const skill: LifecycleSkill = {
        id: 'freeze-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: ['zone:green'],
        code: 'console.log("freeze");',
        meta: { details: { nestedVal: 42 } },
        ...validBaseSkillProps
      };
      manager.registerSkill(skill);

      const retrieved = manager.getSkill('freeze-skill');
      expect(retrieved).toBeDefined();
      expect(Object.isFrozen(retrieved)).toBe(true);

      // Attempting to mutate should throw in strict mode
      expect(() => {
        (retrieved as any).stage = 'versioned';
      }).toThrow();

      expect(() => {
        (retrieved as any).meta.details.nestedVal = 100;
      }).toThrow();
    });
  });

  describe('5. Robustness against Crashes', () => {
    test('Default undefined tags in registerSkill to empty array', () => {
      const skill: any = {
        id: 'no-tags-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        code: 'console.log("no tags");',
        meta: {},
        ...validBaseSkillProps
      };
      delete skill.tags;

      expect(() => manager.registerSkill(skill)).not.toThrow();
      const registered = manager.getSkill('no-tags-skill');
      expect(registered?.tags).toEqual([]);
    });

    test('getPermittedSkills handle null/undefined taskTags and missing skill tags', () => {
      // Register skill without tags
      const skill: any = {
        id: 'robust-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        code: 'console.log("robust");',
        meta: {},
        ...validBaseSkillProps
      };
      delete skill.tags;
      manager.registerSkill(skill);
      manager.transitionTo('robust-skill', 'versioned');

      // Call getPermittedSkills with undefined taskTags
      expect(() => manager.getPermittedSkills(undefined as any)).not.toThrow();
      const permitted = manager.getPermittedSkills(undefined as any);
      expect(permitted.has('robust-skill')).toBe(true);
    });
  });

  describe('6. Second Remediation Verification Suite', () => {
    test('1. Post-Registration Mutations protection', () => {
      const tags = ['zone:green'];
      const meta = { nested: { val: 42 } };
      const skill: LifecycleSkill = {
        id: 'mutation-test-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags,
        code: 'console.log("hello");',
        meta,
        ...validBaseSkillProps
      };

      manager.registerSkill(skill);

      // Mutate external object
      tags.push('zone:red');
      meta.nested.val = 99;

      const registered = manager.getSkill('mutation-test-skill');
      expect(registered).toBeDefined();
      expect(registered?.tags).toEqual(['zone:green']);
      expect(registered?.meta.nested.val).toBe(42);

      // Mutating registered skill should throw (deep frozen)
      expect(() => {
        (registered as any).meta.nested.val = 100;
      }).toThrow();
    });

    test('3. Pre-Deprecation Execution verification', async () => {
      const skill: LifecycleSkill = {
        id: 'pre-dep-skill',
        stage: 'quarantine',
        successDelta: 0.5, // starts below 0.8
        tags: [],
        code: 'console.log("pre-dep");',
        meta: {},
        ...validBaseSkillProps
      };

      manager.registerSkill(skill);

      // Promote to versioned via golden-set run (bypass human admission)
      await manager.executeSkill('pre-dep-skill', false, true);

      const registered = manager.getSkill('pre-dep-skill');
      expect(registered?.stage).toBe('versioned');

      // Now execution (which transitions versioned -> success-delta)
      // should trigger deprecation due to rate < 0.8, and throw before evaluating.
      await expect(
        manager.executeSkill('pre-dep-skill', false, false)
      ).rejects.toThrow(/Execution Denied: LifecycleSkill "pre-dep-skill" is deprecated/);

      expect(manager.getSkill('pre-dep-skill')?.stage).toBe('deprecated');
    });

    test('4. Bearer Token Regex matches colons and spaces', () => {
      const skillWithColon: LifecycleSkill = {
        id: 'bearer-colon-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("test");',
        meta: { customField: 'bearer:xyz-123' },
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skillWithColon)).toThrow(/contains a Bearer token/);

      const skillWithSpaces: LifecycleSkill = {
        id: 'bearer-spaces-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("test");',
        meta: { customField: 'bearer   :   xyz-123' },
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skillWithSpaces)).toThrow(/contains a Bearer token/);
    });

    test('5. Deep Freezing in getUnverifiedSkillsForTask', () => {
      const skill: LifecycleSkill = {
        id: 'unverified-freeze',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: ['zone:green'],
        code: 'console.log("test");',
        meta: { nested: { data: 'hello' } },
        ...validBaseSkillProps
      };

      manager.registerSkill(skill);
      const unverifiedList = manager.getUnverifiedSkillsForTask(['zone:green']);
      expect(unverifiedList.length).toBe(1);

      const unverified = unverifiedList[0];
      expect(Object.isFrozen(unverified)).toBe(true);
      expect(Object.isFrozen(unverified.meta)).toBe(true);
      expect(Object.isFrozen(unverified.meta.nested)).toBe(true);
    });

    test('6. Provenance Stage Preservation and Transition Reachability', () => {
      const skill: LifecycleSkill = {
        id: 'prov-skill',
        stage: 'provenance', // registered explicitly as provenance
        successDelta: 1.0,
        tags: [],
        code: 'console.log("prov");',
        meta: {},
        ...validBaseSkillProps
      };

      manager.registerSkill(skill);
      expect(manager.getSkill('prov-skill')?.stage).toBe('provenance');

      // transition provenance -> quarantine
      expect(() => manager.transitionTo('prov-skill', 'quarantine')).not.toThrow();
      expect(manager.getSkill('prov-skill')?.stage).toBe('quarantine');
    });

    test('7. Robustness: Enforce strict tag formatting and default fallback for taskTags', () => {
      const skillWithInvalidTag: LifecycleSkill = {
        id: 'invalid-tag-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: ['zone:green#invalid'],
        code: 'console.log("test");',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skillWithInvalidTag)).toThrow(/contains invalid characters or homoglyphs/);

      const skillWithColonsAndDashes: LifecycleSkill = {
        id: 'valid-tag-skill-2',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: ['zone:green-sub:restricted'],
        code: 'console.log("test");',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skillWithColonsAndDashes)).not.toThrow();
    });
  });

  describe('7. Third Remediation Verification Suite', () => {
    test('1. Case Splitting AST Bypass (SECRET as uppercase)', () => {
      const skill: LifecycleSkill = {
        id: 'uppercase-secret-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const SECRET = "value";',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/contains forbidden identifier "SECRET"/);
    });

    test('2. Cyrillic/Unicode Homoglyph and Non-ASCII AST Bypass (Identifier)', () => {
      const skill: LifecycleSkill = {
        id: 'homoglyph-ident-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const myАpiKey = "value";', // 'А' is Cyrillic
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/Security Exception: Non-ASCII characters detected in identifier/);
    });

    test('2. Cyrillic/Unicode Homoglyph and Non-ASCII AST Bypass (Property Key)', () => {
      const skill: LifecycleSkill = {
        id: 'homoglyph-prop-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const x = { "apі": "value" };', // 'і' is Cyrillic/Unicode non-ASCII
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/Security Exception: Non-ASCII characters detected/);
    });

    test('3. Class Field/Method AST Check', () => {
      const skillField: LifecycleSkill = {
        id: 'class-field-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'class MyClass { secret = "value"; }',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skillField)).toThrow(/forbidden property key "secret"|forbidden identifier "secret"/);

      const skillMethod: LifecycleSkill = {
        id: 'class-method-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'class MyClass { secret() {} }',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skillMethod)).toThrow(/forbidden property key "secret"|forbidden identifier "secret"/);
    });

    test('4. Computed Member/Property Expression Check', () => {
      const skillDynamic: LifecycleSkill = {
        id: 'computed-dynamic-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const x = obj[getKey()];',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skillDynamic)).toThrow(/Security Exception: Dynamic computed property bypass risk rejected/);

      const skillSimpleLiteral: LifecycleSkill = {
        id: 'computed-literal-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const x = obj["safeProperty"];',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skillSimpleLiteral)).not.toThrow();
    });

    test('5. Standard String Literals in AST', () => {
      const skillLiteral: LifecycleSkill = {
        id: 'literal-credential-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const x = "my-secret-token";',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skillLiteral)).toThrow(/Security Exception: Rejected skill registration: skill source code contains forbidden credential/);
    });

    test('6. ES2022 Private Fields runtime restriction', () => {
      expect((manager as any).skills).toBeUndefined();
      expect((manager as any).observabilityService).toBeUndefined();
      expect((obsService as any).listeners).toBeUndefined();
      expect((obsService as any).skillRates).toBeUndefined();
    });

    test('7. Prototype Pollution Protection in tag subset and optional properties', () => {
      const skill: LifecycleSkill = {
        id: 'proto-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {},
        ...validBaseSkillProps
      };
      // We do not pass memoryBindingId. Check that it is explicitly initialized to undefined.
      manager.registerSkill(skill);
      const registered = manager.getSkill('proto-skill');
      expect(registered).toBeDefined();
      expect('memoryBindingId' in registered!).toBe(true);
      expect(registered!.memoryBindingId).toBeUndefined();

      // Test tag subset check isolation from Array prototype pollution
      (Array.prototype as any).polluted = 'yes';
      const permitted = manager.getPermittedSkills([]);
      expect(permitted).toBeDefined();
      delete (Array.prototype as any).polluted;
    });

    test('8. Direct Listener Invocation with Out-of-Bounds Metrics', () => {
      const skill: LifecycleSkill = {
        id: 'obs-skill-bounds',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {},
        ...validBaseSkillProps
      };
      manager.registerSkill(skill);
      manager.transitionTo('obs-skill-bounds', 'versioned');
      manager.transitionTo('obs-skill-bounds', 'success-delta');

      expect(() => (manager as any).handleSuccessRateUpdate('obs-skill-bounds', 1.5)).toThrow(/Rate must be a decimal value/);
      expect(() => (manager as any).handleSuccessRateUpdate('obs-skill-bounds', NaN)).toThrow(/Rate must be a valid number/);
    });

    test('9. offerVerification.runGoldenSet execution check for deprecated skill', async () => {
      const skill: LifecycleSkill = {
        id: 'offer-dep-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {},
        ...validBaseSkillProps
      };
      manager.registerSkill(skill);
      const offer = manager.offerVerification('offer-dep-skill');

      // Deprecate the skill
      manager.transitionTo('offer-dep-skill', 'deprecated');

      // offerVerification for deprecated skill should throw
      expect(() => manager.offerVerification('offer-dep-skill')).toThrow(/Verification Denied: LifecycleSkill "offer-dep-skill" is deprecated/);

      // runGoldenSet of previously generated offer on now deprecated skill should throw
      await expect(offer.runGoldenSet()).rejects.toThrow(/Verification Denied: LifecycleSkill "offer-dep-skill" is deprecated/);
    });

    test('10. Asynchronous Execution check in executeSkill after evaluation resolves', async () => {
      const skill: LifecycleSkill = {
        id: 'async-dep-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {},
        ...validBaseSkillProps
      };
      manager.registerSkill(skill);

      // We execute it (returns a promise), and concurrently deprecate the skill.
      // When the evaluation promise resolves, the execution should reject because the skill was deprecated.
      const promise = manager.executeSkill('async-dep-skill', true, false);
      
      // Concurrently deprecate the skill
      manager.transitionTo('async-dep-skill', 'deprecated');

      await expect(promise).rejects.toThrow(/Execution Denied: LifecycleSkill "async-dep-skill" is deprecated/);
    });
  });
});
