import { MockContourObservabilityService } from './mock-observability';
import { describe, test, expect, beforeEach } from 'vitest';
import { 
  SkillLifecycleManager, 
  LifecycleSkill,
  RequiresHumanAdmission
} from '../../../server/pipeline/skills/skill-lifecycle-manager';

describe('Adversarial Challenger Remediation 5 Tests', () => {
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

  describe('1. Private Identifier Non-ASCII / Cyrillic Injection', () => {
    test('Should block private field with Cyrillic homoglyph literal', () => {
      const skill: LifecycleSkill = {
        id: 'cyrillic-literal-field',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'class Test { #pаssword = "123"; }', // Cyrillic 'а'
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/Non-ASCII characters detected/);
    });

    test('Should block private field with standard unicode escape', () => {
      const skill: LifecycleSkill = {
        id: 'cyrillic-escape-field',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'class Test { #p\\u0430ssword = "123"; }', // Escape Cyrillic 'а'
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/Non-ASCII characters detected/);
    });

    test('Should block private field with ES6 unicode code point escape', () => {
      const skill: LifecycleSkill = {
        id: 'cyrillic-codepoint-field',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'class Test { #p\\u{0430}ssword = "123"; }', // ES6 escape Cyrillic 'а'
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/Non-ASCII characters detected/);
    });

    test('Should block private method with Cyrillic homoglyph', () => {
      const skill: LifecycleSkill = {
        id: 'cyrillic-method',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'class Test { #pаssword() { return "123"; } }',
        meta: {},
        ...validBaseSkillProps
      };
      expect(() => manager.registerSkill(skill)).toThrow(/Non-ASCII characters detected/);
    });

    test('Bypass check: Injection of non-ASCII private identifier inside eval string literal', () => {
      // Because it is inside a string literal, the AST check does not see it as a PrivateIdentifier node directly.
      // The AST node is a Literal containing the string.
      // And the string uses a Cyrillic homoglyph 'а', which sanitizes to 'pssword' (omitting Cyrillic 'а').
      // Thus, isForbiddenCredential("eval(...)") returns false, and isForbiddenCredential(literal_value) returns false.
      const skill: LifecycleSkill = {
        id: 'cyrillic-eval-bypass',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'eval("class Test { #p\\u0430ssword = \\"123\\"; }");',
        meta: {},
        ...validBaseSkillProps
      };
      
      // Let's verify if this bypass registers successfully!
      let registered = false;
      try {
        manager.registerSkill(skill);
        registered = true;
      } catch (e) {
        registered = false;
      }
      
      // We will record the result in our report.
      console.log('Eval bypass registration success:', registered);
    });
  });

  describe('2. Prototype Chain Infection', () => {
    test('Should reject skill registration with missing fields when Object.prototype is polluted', () => {
      const proto = Object.prototype as any;
      proto.version = '1.0.0';
      proto.provenance = 'human';
      proto.validatedModel = 'gpt-4';
      proto.validatedEnv = 'test';
      proto.bypassgate = true;

      try {
        const badSkill = {
          id: 'polluted-bad-skill',
          stage: 'quarantine',
          meta: {},
          code: 'console.log("hello");',
        } as unknown as LifecycleSkill;

        expect(() => manager.registerSkill(badSkill)).toThrow(/Invalid skill: Missing or invalid version/);
      } finally {
        delete proto.version;
        delete proto.provenance;
        delete proto.validatedModel;
        delete proto.validatedEnv;
        delete proto.bypassgate;
      }
    });

    test('Should not inherit polluted Object.prototype bypassgate or expandallowlist in retrieved skill', () => {
      const proto = Object.prototype as any;
      proto.bypassgate = true;
      proto.expandallowlist = true;

      try {
        const skill: LifecycleSkill = {
          id: 'polluted-valid-skill',
          stage: 'quarantine',
          successDelta: 1.0,
          tags: [],
          code: 'console.log("hello");',
          meta: {},
          ...validBaseSkillProps
        };

        manager.registerSkill(skill);
        const retrieved = manager.getSkill('polluted-valid-skill');
        expect(retrieved).toBeDefined();
        expect((retrieved!.meta as any).bypassgate).toBeUndefined();
        expect((retrieved!.meta as any).expandallowlist).toBeUndefined();
      } finally {
        delete proto.bypassgate;
        delete proto.expandallowlist;
      }
    });

    test('Should check if Array.prototype pollution affects tags or metadata arrays', () => {
      const arrayProto = Array.prototype as any;
      // Attempt to pollute array elements and methods
      arrayProto[0] = '*';
      arrayProto[1] = 'bypass';

      try {
        const skill: LifecycleSkill = {
          id: 'array-polluted-skill',
          stage: 'quarantine',
          successDelta: 1.0,
          tags: [], // Empty tags array should not inherit '*' or 'bypass' as active tags
          code: 'console.log("array test");',
          meta: {},
          ...validBaseSkillProps
        };

        // If Array.prototype pollution affects tag validation or assignment, we see it here.
        // It should register successfully since the empty array length is 0.
        expect(() => manager.registerSkill(skill)).not.toThrow();

        const retrieved = manager.getSkill('array-polluted-skill');
        expect(retrieved).toBeDefined();
        expect(retrieved!.tags).toEqual([]);
      } finally {
        delete arrayProto[0];
        delete arrayProto[1];
      }
    });
  });

  describe('3. Variations of Credential Keys', () => {
    const blockedKeys = ['pass_key', 'authKey', 'key-auth', 'allow_list', 'expand_allow_list'];

    test.each(blockedKeys)('Should block variations of forbidden keys: %s', (key) => {
      const skill: LifecycleSkill = {
        id: `blocked-key-${key}`,
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {
          [key]: 'restricted-value'
        },
        ...validBaseSkillProps
      };

      expect(() => manager.registerSkill(skill)).toThrow(/restricted security parameter key/);
    });

    test('Gaps/Bypasses: Should check if passwd, passphrase, admin, root, bypass in code/meta can bypass checks', () => {
      // Checking passwd in metadata
      const skillPasswd: LifecycleSkill = {
        id: 'passwd-meta-check',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {
          passwd: 'some-password'
        },
        ...validBaseSkillProps
      };
      
      let passwdRegistered = false;
      try {
        manager.registerSkill(skillPasswd);
        passwdRegistered = true;
      } catch (e) {}
      console.log('passwd in metadata registered successfully (bypass):', passwdRegistered);

      // Checking passphrase in metadata
      const skillPassphrase: LifecycleSkill = {
        id: 'passphrase-meta-check',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'console.log("hello");',
        meta: {
          passphrase: 'some-passphrase'
        },
        ...validBaseSkillProps
      };
      
      let passphraseRegistered = false;
      try {
        manager.registerSkill(skillPassphrase);
        passphraseRegistered = true;
      } catch (e) {}
      console.log('passphrase in metadata registered successfully (bypass):', passphraseRegistered);

      // Checking admin in code
      const skillAdminCode: LifecycleSkill = {
        id: 'admin-code-check',
        stage: 'quarantine',
        successDelta: 1.0,
        tags: [],
        code: 'const admin = true;',
        meta: {},
        ...validBaseSkillProps
      };

      let adminCodeRegistered = false;
      try {
        manager.registerSkill(skillAdminCode);
        adminCodeRegistered = true;
      } catch (e) {}
      console.log('admin in code registered successfully (bypass):', adminCodeRegistered);
    });
  });
});
