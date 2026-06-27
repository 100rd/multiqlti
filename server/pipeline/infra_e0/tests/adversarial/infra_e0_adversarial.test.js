/**
 * SPEC-02: Infrastructure Contour (Type E) Adversarial & Stress Test Suite
 */

const { SecurityGate } = require('../../src/security-gate');
const { ProofRouter } = require('../../src/proof-router');
const { ValidationError, RequiresHumanApproval } = require('../../src/errors');
const errors = require('../../src/errors');

const MissingRollbackProofError = errors.MissingRollbackProofError || class MissingRollbackProofError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingRollbackProofError';
  }
};

describe('Infrastructure Contour (Type E) Adversarial Tests', () => {
  let router;

  beforeEach(() => {
    router = new ProofRouter();
  });

  afterEach(() => {
    // Cleanup any prototype pollutions
    delete Object.prototype.rollback_script;
    delete Object.prototype.down_script;
    delete Object.prototype.forward_script;
    delete Object.prototype.up_script;
    delete Object.prototype.smoke_tests;
  });

  describe('SecurityGate - Path Bypasses & Null Bytes', () => {
    test('ADV_SG_PATH_01: "deploy" is forced to Type E', () => {
      const plan = {
        tasks: [{ id: 't-1', type: 'A', authorizedAs: 'A', files: ['deploy'] }]
      };
      SecurityGate.verifyPlan(plan);
      expect(plan.tasks[0].type).toBe('E');
      expect(plan.tasks[0].authorizedAs).toBe('E');
    });

    test('ADV_SG_PATH_02: "migrations" is forced to Type E', () => {
      const plan = {
        tasks: [{ id: 't-2', type: 'A', authorizedAs: 'A', files: ['migrations'] }]
      };
      SecurityGate.verifyPlan(plan);
      expect(plan.tasks[0].type).toBe('E');
      expect(plan.tasks[0].authorizedAs).toBe('E');
    });

    test('ADV_SG_PATH_03: "package.json" is forced to Type E', () => {
      const plan = {
        tasks: [{ id: 't-3', type: 'A', authorizedAs: 'A', files: ['package.json'] }]
      };
      SecurityGate.verifyPlan(plan);
      expect(plan.tasks[0].type).toBe('E');
      expect(plan.tasks[0].authorizedAs).toBe('E');
    });

    test('ADV_SG_PATH_04: "src/deploy/something.yml" is forced to Type E', () => {
      const plan = {
        tasks: [{ id: 't-4', type: 'A', authorizedAs: 'A', files: ['src/deploy/something.yml'] }]
      };
      SecurityGate.verifyPlan(plan);
      expect(plan.tasks[0].type).toBe('E');
      expect(plan.tasks[0].authorizedAs).toBe('E');
    });

    test('ADV_SG_PATH_05: "migrations/../migrations/db.sql" is forced to Type E', () => {
      const plan = {
        tasks: [{ id: 't-5', type: 'A', authorizedAs: 'A', files: ['migrations/../migrations/db.sql'] }]
      };
      SecurityGate.verifyPlan(plan);
      expect(plan.tasks[0].type).toBe('E');
      expect(plan.tasks[0].authorizedAs).toBe('E');
    });

    test('ADV_SG_PATH_06: "src/../../package.json" is forced to Type E', () => {
      const plan = {
        tasks: [{ id: 't-6', type: 'A', authorizedAs: 'A', files: ['src/../../package.json'] }]
      };
      SecurityGate.verifyPlan(plan);
      expect(plan.tasks[0].type).toBe('E');
      expect(plan.tasks[0].authorizedAs).toBe('E');
    });

    test('ADV_SG_PATH_07A: "migrations\\\\001.sql" (backslash) is forced to Type E', () => {
      const plan = {
        tasks: [{ id: 't-7a', type: 'A', authorizedAs: 'A', files: ['migrations\\\\001.sql'] }]
      };
      SecurityGate.verifyPlan(plan);
      expect(plan.tasks[0].type).toBe('E');
      expect(plan.tasks[0].authorizedAs).toBe('E');
    });

    test('ADV_SG_PATH_07B: "migrations\\x01.sql" (control char) is handled', () => {
      const plan = {
        tasks: [{ id: 't-7b', type: 'A', authorizedAs: 'A', files: ['migrations\x01.sql'] }]
      };
      const res = SecurityGate.verifyPlan(plan);
      expect(res).toBe(true);
    });

    test('ADV_SG_PATH_08: "migrations/001.sql\\u0000" (null byte injection at the end) is forced to Type E', () => {
      const plan = {
        tasks: [{ id: 't-8', type: 'A', authorizedAs: 'A', files: ['migrations/001.sql\u0000'] }]
      };
      SecurityGate.verifyPlan(plan);
      expect(plan.tasks[0].type).toBe('E');
      expect(plan.tasks[0].authorizedAs).toBe('E');
    });

    test('ADV_SG_PATH_09: "migrations\\u0000/001.sql" (null byte in directory) must throw ValidationError or be forced to E', () => {
      const plan = {
        tasks: [{ id: 't-9', type: 'A', authorizedAs: 'A', files: ['migrations\u0000/001.sql'] }]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_SG_PATH_10A: Unicode homoglyph bypasses - Cyrillic "а" in "migrations" is blocked/normalized', () => {
      const plan = {
        tasks: [{ id: 't-10a', type: 'A', authorizedAs: 'A', files: ['m\u0430grations/db.sql'] }]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_SG_PATH_10B: Unicode homoglyph bypasses - Cyrillic "о" in "deploy" is blocked/normalized', () => {
      const plan = {
        tasks: [{ id: 't-10b', type: 'A', authorizedAs: 'A', files: ['dep\u043e\u0443/something.yml'] }]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_SG_PATH_10C: Unicode homoglyph bypasses - Cyrillic "а" in "package.json" is blocked/normalized', () => {
      const plan = {
        tasks: [{ id: 't-10c', type: 'A', authorizedAs: 'A', files: ['p\u0430ck\u0430ge.json'] }]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });
  });

  describe('SecurityGate - Accessor Property Injection', () => {
    test('ADV_SG_ACC_01: Getter/setter on "files" is blocked', () => {
      const task = { id: 't-acc-1', type: 'A', authorizedAs: 'A' };
      Object.defineProperty(task, 'files', {
        get() { return ['migrations/db.sql']; },
        configurable: true,
        enumerable: true
      });
      const plan = { tasks: [task] };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_SG_ACC_02: Getter/setter on "paths" is blocked', () => {
      const task = { id: 't-acc-2', type: 'A', authorizedAs: 'A' };
      Object.defineProperty(task, 'paths', {
        get() { return ['deploy/service.yml']; },
        configurable: true,
        enumerable: true
      });
      const plan = { tasks: [task] };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_SG_ACC_03: State-changing getter on "plan.tasks" is blocked or handled safely', () => {
      let accessed = 0;
      const tasks1 = [{ id: 't-acc-3a', type: 'A', authorizedAs: 'A', files: [] }];
      const tasks2 = [{ id: 't-acc-3b', type: 'A', authorizedAs: 'A', files: ['migrations/db.sql'] }];
      const plan = {};
      Object.defineProperty(plan, 'tasks', {
        get() {
          accessed++;
          return accessed === 1 ? tasks1 : tasks2;
        },
        configurable: true,
        enumerable: true
      });

      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });
  });

  describe('ProofRouter - Validation & Bypasses', () => {
    test('ADV_PR_BYP_04: Proxy payload bypassing accessor checks via ownKeys trap is blocked', () => {
      const task = { id: 't-e-proxy', type: 'E' };
      const target = {};
      const handler = {
        ownKeys(target) {
          return [];
        },
        getOwnPropertyDescriptor(target, prop) {
          if (['rollback_script', 'forward_script', 'smoke_tests', 'forward_success', 'rollback_success', 'smoke_tests_success'].includes(prop)) {
            return {
              value: prop.endsWith('_success') ? true : (prop === 'smoke_tests' ? 'SELECT 1;' : 'SCRIPT;'),
              writable: true,
              enumerable: true,
              configurable: true
            };
          }
          return undefined;
        },
        get(target, prop) {
          if (prop === 'rollback_script') return 'DROP TABLE t;';
          if (prop === 'forward_script') return 'CREATE TABLE t;';
          if (prop === 'smoke_tests') return 'SELECT 1;';
          if (prop === 'forward_success' || prop === 'rollback_success' || prop === 'smoke_tests_success') return true;
          return undefined;
        }
      };

      const proxy = new Proxy(target, handler);
      expect(() => router.submitCompletedTask(task, proxy)).toThrow(ValidationError);
    });

    test('ADV_PR_BYP_05: Prototype-polluted rollback_script is blocked when own property is missing', () => {
      const task = { id: 't-e-polluted', type: 'E' };
      Object.prototype.rollback_script = 'DROP TABLE t;';
      try {
        const proof = {
          forward_script: 'CREATE TABLE t;',
          smoke_tests: 'SELECT 1;',
          forward_success: true,
          smoke_tests_success: true
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow(MissingRollbackProofError);
      } finally {
        delete Object.prototype.rollback_script;
      }
    });

    test('ADV_PR_BYP_06: Nested object accessor injection for rollback_script is blocked', () => {
      const task = { id: 't-e-nested-acc', type: 'E' };
      const proof = {
        forward_script: 'CREATE TABLE t;',
        rollback_script: {
          get toString() {
            return () => 'DROP TABLE t;';
          }
        },
        smoke_tests: 'SELECT 1;',
        forward_success: true,
        rollback_success: true,
        smoke_tests_success: true
      };
      // Expect validation error because rollback_script value itself contains/is an accessor or not a primitive string.
      // Or at least it should throw ValidationError due to type mismatch or security gate checks.
      expect(() => router.submitCompletedTask(task, proof)).toThrow(ValidationError);
    });
  });

  describe('SecurityGate - Advanced Proxy & TOCTOU Bypasses', () => {
    test('ADV_SG_ACC_04: TOCTOU bypass via array element getter on "files" is blocked', () => {
      const task = {
        id: 't-acc-4',
        type: 'A',
        authorizedAs: 'A',
        files: []
      };

      let readCount = 0;
      Object.defineProperty(task.files, '0', {
        get() {
          readCount++;
          if (readCount <= 1) {
            return 'src/app.js';
          } else {
            return 'migrations/db.sql';
          }
        },
        enumerable: true,
        configurable: true
      });

      const plan = { tasks: [task] };
      // Even if it passes verifyPlan initially, if it behaves dynamically it should be blocked
      // or verified again. If we expect the gate to reject array index accessors:
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_SG_ACC_05: Proxy task preventing type / authorizedAs modification is blocked', () => {
      const taskTarget = {};
      const taskHandler = {
        getOwnPropertyDescriptor(target, prop) {
          if (['id', 'type', 'authorizedAs', 'files'].includes(prop)) {
            return {
              value: prop === 'id' ? 't-1' : (prop === 'type' ? 'A' : (prop === 'authorizedAs' ? 'A' : undefined)),
              writable: true,
              configurable: true,
              enumerable: true
            };
          }
        },
        get(target, prop) {
          if (prop === 'id') return 't-1';
          if (prop === 'type') return 'A'; // Spoof: always return 'A'
          if (prop === 'authorizedAs') return 'A'; // Spoof: always return 'A'
          if (prop === 'files') return ['migrations/db.sql']; // Touches sensitive
        },
        set(target, prop, value) {
          // Ignore writes to type and authorizedAs
          return true;
        }
      };
      const proxyTask = new Proxy(taskTarget, taskHandler);
      const plan = { tasks: [proxyTask] };

      // The gate should either throw ValidationError when detecting a Proxy,
      // or fail to verify, or detect that type was not successfully updated to E.
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });
  });
});

