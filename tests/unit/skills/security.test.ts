import { MockContourObservabilityService } from './mock-observability';
import { describe, test, expect, beforeEach } from 'vitest';
import { 
  SkillLifecycleManager, 
  LifecycleSkill 
} from '../../../server/pipeline/skills/skill-lifecycle-manager';

describe('LifecycleSkill Lifecycle Manager - R3 Security Verification', () => {
  let cos: MockContourObservabilityService;
  let slm: SkillLifecycleManager;

  beforeEach(() => {
    cos = new MockContourObservabilityService();
    slm = new SkillLifecycleManager(cos);
  });

  test('R3: Registration is rejected if skill contains authorization parameters in meta keys', () => {
    const insecureSkill: LifecycleSkill = {
      id: 'insecure-1',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: ['zone:green'],
      code: 'console.log("clean");',
      meta: {
        credentials: {
          apiToken: 'secret-auth-value'
        }
      },
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };

    expect(() => slm.registerSkill(insecureSkill)).toThrow(/Security Exception/);
  });

  test('R3: Registration is rejected if skill contains token assignments in code body', () => {
    const insecureSkill: LifecycleSkill = {
      id: 'insecure-2',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: ['zone:green'],
      code: 'const bearerToken = "someToken";',
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };

    expect(() => slm.registerSkill(insecureSkill)).toThrow(/Security Exception/);
  });

  test('R3: Registration is rejected if skill contains allow-list expansion tags', () => {
    const insecureSkill: LifecycleSkill = {
      id: 'insecure-3',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: ['*'], // Wildcard tag
      code: 'console.log("bad tags");',
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };

    expect(() => slm.registerSkill(insecureSkill)).toThrow(/Security Exception/);
  });

  test('R3: Rejects skill registration attempting allow-list expansion flag in meta', () => {
    const badSkill: LifecycleSkill = {
      id: 'exploit-4',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: [],
      code: 'console.log("expand");',
      meta: {
        expandAllowList: true
      },
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };

    expect(() => slm.registerSkill(badSkill)).toThrow(/Security Exception/);
  });

  test('R3: Assignment asymmetric checks filter out unauthorized skills (Explorer 3 variant)', () => {
    const skillA: LifecycleSkill = {
      id: 'skill-alpha',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: ['zone:green'],
      code: 'console.log("alpha");',
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };
    const skillB: LifecycleSkill = {
      id: 'skill-beta',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: ['zone:green', 'zone:restricted'],
      code: 'console.log("beta");',
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };

    slm.registerSkill(skillA);
    slm.registerSkill(skillB);

    // Transition them to active 'versioned' stage so they can be assigned
    slm.transitionTo('skill-alpha', 'versioned');
    slm.transitionTo('skill-beta', 'versioned');

    // Case 1: Task with basic green authorization
    const permittedGreen = slm.getPermittedSkills(['zone:green']);
    expect(permittedGreen.has('skill-alpha')).toBe(true);
    expect(permittedGreen.has('skill-beta')).toBe(false); // Fails since task lacks 'zone:restricted'

    // Case 2: Task with restricted authorization
    const permittedRestricted = slm.getPermittedSkills(['zone:green', 'zone:restricted']);
    expect(permittedRestricted.has('skill-alpha')).toBe(true);
    expect(permittedRestricted.has('skill-beta')).toBe(true); // Both match now
  });

  test('R3: getPermittedSkills returns filtered set based on zone gate tags (Explorer 1 variant)', async () => {
    const skillA: LifecycleSkill = {
      id: 'skill-alpha-1',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: ['zone:green'],
      code: 'console.log("alpha");',
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };

    const skillB: LifecycleSkill = {
      id: 'skill-beta-1',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: ['zone:red', 'gate:alpha'],
      code: 'console.log("beta");',
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };

    slm.registerSkill(skillA);
    slm.registerSkill(skillB);

    // Promote both to versioned first via golden runs to make them active
    await slm.executeSkill('skill-alpha-1', false, true);
    await slm.executeSkill('skill-beta-1', false, true);

    // Check permissions for zone:green
    const permittedGreen = slm.getPermittedSkills(['zone:green']);
    expect(permittedGreen.has('skill-alpha-1')).toBe(true);
    expect(permittedGreen.has('skill-beta-1')).toBe(false);

    // Check permissions for zone:red (fails beta because gate:alpha is missing)
    const permittedRedOnly = slm.getPermittedSkills(['zone:red']);
    expect(permittedRedOnly.has('skill-beta-1')).toBe(false);

    // Check permissions for zone:red and gate:alpha
    const permittedRedAlpha = slm.getPermittedSkills(['zone:red', 'gate:alpha']);
    expect(permittedRedAlpha.has('skill-beta-1')).toBe(true);
  });

  test('Remediation: Cyrillic/non-ASCII characters in private identifiers are blocked', () => {
    const badSkill: LifecycleSkill = {
      id: 'cyrillic-private-id',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: [],
      code: 'class Test { #pаssword = "secret"; }', // Cyrillic 'а'
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };
    expect(() => slm.registerSkill(badSkill)).toThrow(/Security Exception: Non-ASCII characters detected in private identifier/);
  });

  test('Remediation: Object prototype pollution is isolated', () => {
    const proto = Object.prototype as any;
    proto.version = '1.0.0';
    proto.provenance = 'human';
    proto.validatedModel = 'gpt-4';
    proto.validatedEnv = 'test';
    proto.bypassgate = true;

    try {
      // LifecycleSkill missing version, provenance, validatedModel, validatedEnv
      const badSkill = {
        id: 'polluted-skill',
        stage: 'quarantine',
        meta: {},
        code: 'console.log("hello");',
      } as unknown as LifecycleSkill;

      expect(() => slm.registerSkill(badSkill)).toThrow(/Invalid skill: Missing or invalid version/);

      // Verify that privilege bypass flags like bypassgate in Object.prototype are not inherited by meta
      const validSkill: LifecycleSkill = {
        id: 'valid-skill',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {},
        version: '1.0.0',
        provenance: 'human',
        validatedModel: 'gpt-4',
        validatedEnv: 'test'
      };
      
      slm.registerSkill(validSkill);
      const retrieved = slm.getSkill('valid-skill');
      expect(retrieved).toBeDefined();
      expect(retrieved!.meta).toBeDefined();
      expect((retrieved!.meta as any).bypassgate).toBeUndefined();
    } finally {
      delete proto.version;
      delete proto.provenance;
      delete proto.validatedModel;
      delete proto.validatedEnv;
      delete proto.bypassgate;
    }
  });

  test('Remediation: Word combinations like passkey, authkey, authpass are rejected', () => {
    const keys = ['passkey', 'authkey', 'authpass', 'auth_key', 'pass-key'];
    for (const key of keys) {
      const badSkill: LifecycleSkill = {
        id: `bad-meta-${key}`,
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {
          [key]: 'some-val'
        },
        version: '1.0.0',
        provenance: 'human',
        validatedModel: 'gpt-4',
        validatedEnv: 'test'
      };
      expect(() => slm.registerSkill(badSkill)).toThrow(/restricted security parameter key/);
    }
  });
});

