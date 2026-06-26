/**
 * SPEC-02: Infrastructure Contour (Type E) E2E Test Suite
 * Milestone 2: E2E Test Suite Design & Generation
 */

const { SecurityGate } = require('../../src/security-gate');
const { ProofRouter } = require('../../src/proof-router');
const errors = require('../../src/errors');
const ValidationError = errors.ValidationError;
const RequiresHumanApproval = errors.RequiresHumanApproval;

// Fallback if MissingRollbackProofError is not yet implemented/exported by src/errors.js
const MissingRollbackProofError = errors.MissingRollbackProofError || class MissingRollbackProofError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingRollbackProofError';
  }
};

describe('Infrastructure Contour (Type E) E2E Test Suite', () => {
  let router;

  beforeEach(() => {
    router = new ProofRouter();
  });

  describe('Tier 1: Feature Coverage', () => {
    describe('Feature 1: Migration Proof Triad Evaluator (Type E tasks)', () => {
      test('T1_FE1_01: Submitting Type E task with successful forward script, successful rollback script, and successful smoke tests returns true', () => {
        const task = { id: 't-e-1', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          rollback_script: 'DROP TABLE t;',
          smoke_tests: 'SELECT * FROM t;',
          forward_success: true,
          rollback_success: true,
          smoke_tests_success: true
        };
        expect(router.submitCompletedTask(task, proof)).toBe(true);
      });

      test('T1_FE1_02: Submitting Type E task without rollback_script/down_script throws MissingRollbackProofError', () => {
        const task = { id: 't-e-2', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          smoke_tests: 'SELECT * FROM t;',
          forward_success: true,
          smoke_tests_success: true
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow(MissingRollbackProofError);
      });

      test('T1_FE1_03: Submitting Type E task with empty rollback_script throws MissingRollbackProofError', () => {
        const task = { id: 't-e-3', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          rollback_script: '',
          smoke_tests: 'SELECT * FROM t;',
          forward_success: true,
          smoke_tests_success: true
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow(MissingRollbackProofError);
      });

      test('T1_FE1_04A: Submitting Type E task with rollback_success: false throws MissingRollbackProofError', () => {
        const task = { id: 't-e-4a', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          rollback_script: 'DROP TABLE t;',
          smoke_tests: 'SELECT * FROM t;',
          forward_success: true,
          rollback_success: false,
          smoke_tests_success: true
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow(MissingRollbackProofError);
      });

      test('T1_FE1_04B: Submitting Type E task with down_script_success: false throws MissingRollbackProofError', () => {
        const task = { id: 't-e-4b', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          down_script: 'DROP TABLE t;',
          smoke_tests: 'SELECT * FROM t;',
          forward_success: true,
          down_script_success: false,
          smoke_tests_success: true
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow(MissingRollbackProofError);
      });

      test('T1_FE1_04C: Submitting Type E task with rollback_execution: "failed" throws MissingRollbackProofError', () => {
        const task = { id: 't-e-4c', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          rollback_script: 'DROP TABLE t;',
          smoke_tests: 'SELECT * FROM t;',
          forward_success: true,
          rollback_execution: 'failed',
          smoke_tests_success: true
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow(MissingRollbackProofError);
      });

      test('T1_FE1_05A: Submitting Type E task with up_script_success: false throws ValidationError', () => {
        const task = { id: 't-e-5a', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          rollback_script: 'DROP TABLE t;',
          smoke_tests: 'SELECT * FROM t;',
          up_script_success: false,
          rollback_success: true,
          smoke_tests_success: true
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow(ValidationError);
      });

      test('T1_FE1_05B: Submitting Type E task with forward_success: false throws ValidationError', () => {
        const task = { id: 't-e-5b', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          rollback_script: 'DROP TABLE t;',
          smoke_tests: 'SELECT * FROM t;',
          forward_success: false,
          rollback_success: true,
          smoke_tests_success: true
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow(ValidationError);
      });

      test('T1_FE1_05C: Submitting Type E task with forward_execution: "failed" throws ValidationError', () => {
        const task = { id: 't-e-5c', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          rollback_script: 'DROP TABLE t;',
          smoke_tests: 'SELECT * FROM t;',
          forward_execution: 'failed',
          rollback_success: true,
          smoke_tests_success: true
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow(ValidationError);
      });

      test('T1_FE1_06A: Submitting Type E task with smoke_tests_success: false throws ValidationError', () => {
        const task = { id: 't-e-6a', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          rollback_script: 'DROP TABLE t;',
          smoke_tests: 'SELECT * FROM t;',
          forward_success: true,
          rollback_success: true,
          smoke_tests_success: false
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow(ValidationError);
      });

      test('T1_FE1_06B: Submitting Type E task with smoke_test_verification: "failed" throws ValidationError', () => {
        const task = { id: 't-e-6b', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          rollback_script: 'DROP TABLE t;',
          smoke_tests: 'SELECT * FROM t;',
          forward_success: true,
          rollback_success: true,
          smoke_test_verification: 'failed'
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow(ValidationError);
      });
    });

    describe('Feature 2: Infrastructure Zone-Gate Extension', () => {
      test('T1_FE2_01: Touching a file in migrations/ correctly forces the task routing type to Type E and authorizedAs to Type E', () => {
        const plan = {
          tasks: [{ id: 't-f2-1', type: 'A', authorizedAs: 'A', files: ['migrations/001_init.sql'] }]
        };
        SecurityGate.verifyPlan(plan);
        expect(plan.tasks[0].type).toBe('E');
        expect(plan.tasks[0].authorizedAs).toBe('E');
      });

      test('T1_FE2_02: Touching a file in deploy/ correctly forces the task routing type to Type E and authorizedAs to Type E', () => {
        const plan = {
          tasks: [{ id: 't-f2-2', type: 'B', authorizedAs: 'B', files: ['deploy/deployment.yaml'] }]
        };
        SecurityGate.verifyPlan(plan);
        expect(plan.tasks[0].type).toBe('E');
        expect(plan.tasks[0].authorizedAs).toBe('E');
      });

      test('T1_FE2_03: Touching a file named package.json correctly forces the task routing type to Type E and authorizedAs to Type E', () => {
        const plan = {
          tasks: [{ id: 't-f2-3', type: 'C', authorizedAs: 'C', files: ['package.json'] }]
        };
        SecurityGate.verifyPlan(plan);
        expect(plan.tasks[0].type).toBe('E');
        expect(plan.tasks[0].authorizedAs).toBe('E');
      });

      test('T1_FE2_04: Verify normal tasks (not touching migrations/, deploy/, or package.json) are NOT forced to Type E', () => {
        const plan = {
          tasks: [{ id: 't-f2-4', type: 'A', authorizedAs: 'A', files: ['src/app.js'] }]
        };
        SecurityGate.verifyPlan(plan);
        expect(plan.tasks[0].type).toBe('A');
        expect(plan.tasks[0].authorizedAs).toBe('A');
      });

      test('T1_FE2_05: Multiple files (one normal, one touching deploy/) forces routing type and authorizedAs to Type E', () => {
        const plan = {
          tasks: [{ id: 't-f2-5', type: 'A', authorizedAs: 'A', files: ['src/app.js', 'deploy/service.yaml'] }]
        };
        SecurityGate.verifyPlan(plan);
        expect(plan.tasks[0].type).toBe('E');
        expect(plan.tasks[0].authorizedAs).toBe('E');
      });
    });
  });

  describe('Tier 2: Boundary & Edge Cases', () => {
    describe('Feature 1 Boundaries', () => {
      test('T2_FE1_01: Accessor properties on rollback_script or other triad fields throw validation errors to prevent TOCTOU', () => {
        const task = { id: 't-b1-1', type: 'E' };
        const proof = {};
        Object.defineProperty(proof, 'rollback_script', {
          get() { return 'DROP TABLE t;'; },
          configurable: true,
          enumerable: true
        });
        expect(() => router.submitCompletedTask(task, proof)).toThrow(ValidationError);
      });

      test('T2_FE1_02: Null/undefined values for success flags behave as false (throws)', () => {
        const task = { id: 't-b1-2', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          rollback_script: 'DROP TABLE t;',
          smoke_tests: 'SELECT 1;',
          forward_success: null,
          rollback_success: undefined,
          smoke_tests_success: true
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow();
      });

      test('T2_FE1_03: Submitting Type E task with empty down_script throws MissingRollbackProofError', () => {
        const task = { id: 't-b1-3', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          down_script: '',
          smoke_tests: 'SELECT * FROM t;',
          forward_success: true,
          down_script_success: true,
          smoke_tests_success: true
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow(MissingRollbackProofError);
      });

      test('T2_FE1_04: Whitespace-only forward_script or smoke_tests throws ValidationError', () => {
        const task = { id: 't-b1-4', type: 'E' };
        const proof = {
          forward_script: '   ',
          rollback_script: 'DROP TABLE t;',
          smoke_tests: '   ',
          forward_success: true,
          rollback_success: true,
          smoke_tests_success: true
        };
        expect(() => router.submitCompletedTask(task, proof)).toThrow(ValidationError);
      });

      test('T2_FE1_05: Extra parameters in proofPayload do not affect validation and return true', () => {
        const task = { id: 't-b1-5', type: 'E' };
        const proof = {
          forward_script: 'CREATE TABLE t;',
          rollback_script: 'DROP TABLE t;',
          smoke_tests: 'SELECT 1;',
          forward_success: true,
          rollback_success: true,
          smoke_tests_success: true,
          extra_metric: 42,
          operator: 'admin'
        };
        expect(router.submitCompletedTask(task, proof)).toBe(true);
      });
    });

    describe('Feature 2 Boundaries', () => {
      test('T2_FE2_01: Check path normalization: task files with backslashes (e.g., migrations\\\\db.sql) are forced to Type E', () => {
        const plan = {
          tasks: [{ id: 't-b2-1', type: 'A', authorizedAs: 'A', files: ['migrations\\\\db.sql'] }]
        };
        SecurityGate.verifyPlan(plan);
        expect(plan.tasks[0].type).toBe('E');
        expect(plan.tasks[0].authorizedAs).toBe('E');
      });

      test('T2_FE2_02: Check path normalization: task files in nested directories (e.g., src/deploy/server.yaml) are forced to Type E', () => {
        const plan = {
          tasks: [{ id: 't-b2-2', type: 'A', authorizedAs: 'A', paths: ['src/deploy/server.yaml'] }]
        };
        SecurityGate.verifyPlan(plan);
        expect(plan.tasks[0].type).toBe('E');
        expect(plan.tasks[0].authorizedAs).toBe('E');
      });

      test('T2_FE2_03: Check path normalization: task files with relative segments (e.g., migrations/../migrations/init.sql) are forced to Type E', () => {
        const plan = {
          tasks: [{ id: 't-b2-3', type: 'A', authorizedAs: 'A', files: ['migrations/../migrations/init.sql'] }]
        };
        SecurityGate.verifyPlan(plan);
        expect(plan.tasks[0].type).toBe('E');
        expect(plan.tasks[0].authorizedAs).toBe('E');
      });

      test('T2_FE2_04A: Task with files parameter as a single string instead of array of strings', () => {
        const plan = {
          tasks: [{ id: 't-b2-4a', type: 'A', authorizedAs: 'A', files: 'migrations/db.sql' }]
        };
        SecurityGate.verifyPlan(plan);
        expect(plan.tasks[0].type).toBe('E');
        expect(plan.tasks[0].authorizedAs).toBe('E');
      });

      test('T2_FE2_04B: Task with paths parameter as a single string instead of array of strings', () => {
        const plan = {
          tasks: [{ id: 't-b2-4b', type: 'A', authorizedAs: 'A', paths: 'deploy/deployment.yaml' }]
        };
        SecurityGate.verifyPlan(plan);
        expect(plan.tasks[0].type).toBe('E');
        expect(plan.tasks[0].authorizedAs).toBe('E');
      });

      test('T2_FE2_05: Task with empty files/paths array is not forced to Type E', () => {
        const plan = {
          tasks: [{ id: 't-b2-5', type: 'A', authorizedAs: 'A', files: [], paths: [] }]
        };
        SecurityGate.verifyPlan(plan);
        expect(plan.tasks[0].type).toBe('A');
        expect(plan.tasks[0].authorizedAs).toBe('A');
      });

      test('T2_FE2_06: Prototype pollution / accessor-based properties on files or paths throw ValidationError', () => {
        const badTask = { id: 't-b2-6', type: 'A', authorizedAs: 'A' };
        Object.defineProperty(badTask, 'files', {
          get() { return ['migrations/db.sql']; },
          configurable: true,
          enumerable: true
        });
        const plan = { tasks: [badTask] };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
      });
    });
  });

  describe('Tier 3: Cross-Feature Combinations', () => {
    test('T3_COMB_01: Plan with multiple tasks: one touching migrations (forced to E), one normal Type A task (not forced)', () => {
      const plan = {
        tasks: [
          { id: 't-c1-1', type: 'A', authorizedAs: 'A', files: ['migrations/db.sql'] },
          { id: 't-c1-2', type: 'A', authorizedAs: 'A', files: ['src/app.js'] }
        ]
      };
      SecurityGate.verifyPlan(plan);
      expect(plan.tasks[0].type).toBe('E');
      expect(plan.tasks[0].authorizedAs).toBe('E');
      expect(plan.tasks[1].type).toBe('A');
      expect(plan.tasks[1].authorizedAs).toBe('A');
    });

    test('T3_COMB_02: Precedence check (Type D task first) throws RequiresHumanApproval', () => {
      const plan = {
        tasks: [
          { id: 't-c1-3', type: 'D', authorizedAs: 'D' },
          { id: 't-c1-4', type: 'A', authorizedAs: 'A', files: ['migrations/db.sql'] }
        ]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(RequiresHumanApproval);
    });

    test('T3_COMB_03: Precedence check (Type E forced task first) throws RequiresHumanApproval', () => {
      const plan = {
        tasks: [
          { id: 't-c1-5', type: 'A', authorizedAs: 'A', files: ['migrations/db.sql'] },
          { id: 't-c1-6', type: 'D', authorizedAs: 'D' }
        ]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(RequiresHumanApproval);
    });

    test('T3_COMB_04: Multiple files in multiple properties (files and paths) targeting different forced zones', () => {
      const plan = {
        tasks: [{
          id: 't-c1-7',
          type: 'A',
          authorizedAs: 'A',
          files: ['deploy/k8s.yaml'],
          paths: ['package.json']
        }]
      };
      SecurityGate.verifyPlan(plan);
      expect(plan.tasks[0].type).toBe('E');
      expect(plan.tasks[0].authorizedAs).toBe('E');
    });

    test('T3_COMB_05: Pipeline test: forced Type E task verified, then executed with proof triad', () => {
      const plan = {
        tasks: [{ id: 't-c1-8', type: 'A', authorizedAs: 'A', files: ['migrations/db.sql'] }]
      };
      expect(SecurityGate.verifyPlan(plan)).toBe(true);
      expect(plan.tasks[0].type).toBe('E');
      
      const proof = {
        forward_script: 'CREATE TABLE t;',
        rollback_script: 'DROP TABLE t;',
        smoke_tests: 'SELECT 1;',
        forward_success: true,
        rollback_success: true,
        smoke_tests_success: true
      };
      expect(router.submitCompletedTask(plan.tasks[0], proof)).toBe(true);
    });
  });

  describe('Tier 4: Real-world Workload', () => {
    test('T4_WORK_01: E2E execution of a plan containing sensitive and non-sensitive tasks', () => {
      const plan = {
        tasks: [
          { id: 't-w1-1', type: 'A', authorizedAs: 'A', files: ['src/index.js'] },
          { id: 't-w1-2', type: 'A', authorizedAs: 'A', files: ['migrations/schema.sql'] },
          { id: 't-w1-3', type: 'B', authorizedAs: 'B', files: ['src/button.png'] }
        ]
      };
      expect(SecurityGate.verifyPlan(plan)).toBe(true);
      
      // Submit non-sensitive A
      expect(router.submitCompletedTask(plan.tasks[0], {})).toBe(true);
      
      // Submit sensitive E (forced)
      const proofE = {
        forward_script: 'CREATE TABLE t;',
        rollback_script: 'DROP TABLE t;',
        smoke_tests: 'SELECT 1;',
        forward_success: true,
        rollback_success: true,
        smoke_tests_success: true
      };
      expect(router.submitCompletedTask(plan.tasks[1], proofE)).toBe(true);
      
      // Submit non-sensitive B (requires pixel_diff)
      expect(router.submitCompletedTask(plan.tasks[2], { pixel_diff: 'hash' })).toBe(true);
    });

    test('T4_WORK_02: Failed migration rollback recovery workflow in real-world scenario', () => {
      const plan = {
        tasks: [{ id: 't-w1-4', type: 'A', authorizedAs: 'A', files: ['deploy/helm/values.yaml'] }]
      };
      expect(SecurityGate.verifyPlan(plan)).toBe(true);
      
      // Submit with failed rollback
      const badProof = {
        forward_script: 'UP;',
        rollback_script: 'DOWN;',
        smoke_tests: 'SMOKE;',
        forward_success: true,
        rollback_success: false,
        smoke_tests_success: true
      };
      expect(() => router.submitCompletedTask(plan.tasks[0], badProof)).toThrow(MissingRollbackProofError);
      
      // Correct the proof and resubmit
      const goodProof = {
        forward_script: 'UP;',
        rollback_script: 'DOWN;',
        smoke_tests: 'SMOKE;',
        forward_success: true,
        rollback_success: true,
        smoke_tests_success: true
      };
      expect(router.submitCompletedTask(plan.tasks[0], goodProof)).toBe(true);
    });

    test('T4_WORK_03: Complex deployment plan routing and proof verification with multiple privileges', () => {
      const plan = {
        tasks: [
          { id: 't-w1-5', type: 'C', authorizedAs: 'C', files: ['package.json'] },
          { id: 't-w1-6', type: 'B', authorizedAs: 'B', files: ['src/logo.svg'] }
        ]
      };
      expect(SecurityGate.verifyPlan(plan)).toBe(true);
      expect(plan.tasks[0].type).toBe('E'); // package.json forced to E
      expect(plan.tasks[1].type).toBe('B'); // unchanged
      
      // Proofs
      const proofE = {
        forward_script: 'UP;',
        down_script: 'DOWN;',
        smoke_tests: 'SMOKE;',
        forward_success: true,
        down_script_success: true,
        smoke_tests_success: true
      };
      expect(router.submitCompletedTask(plan.tasks[0], proofE)).toBe(true);
      expect(router.submitCompletedTask(plan.tasks[1], { pixel_diff: 'diff' })).toBe(true);
    });

    test('T4_WORK_04: Adversarial plan bypass attempt using relative segment tricks is successfully blocked and forced to E', () => {
      const plan = {
        tasks: [{
          id: 't-w1-7',
          type: 'A',
          authorizedAs: 'A',
          files: ['src/../migrations/../deploy/config.json'] // resolves to deploy/config.json
        }]
      };
      expect(SecurityGate.verifyPlan(plan)).toBe(true);
      expect(plan.tasks[0].type).toBe('E');
      expect(plan.tasks[0].authorizedAs).toBe('E');
    });

    test('T4_WORK_05: Plan with large batch of tasks and dynamic zone-gate checks', () => {
      const tasks = [];
      for (let i = 0; i < 15; i++) {
        tasks.push({
          id: `t-w1-batch-${i}`,
          type: 'A',
          authorizedAs: 'A',
          files: i === 7 ? ['migrations/users.sql'] : [`src/file-${i}.js`]
        });
      }
      const plan = { tasks };
      expect(SecurityGate.verifyPlan(plan)).toBe(true);
      expect(plan.tasks[7].type).toBe('E');
      expect(plan.tasks[7].authorizedAs).toBe('E');
      for (let i = 0; i < 15; i++) {
        if (i !== 7) {
          expect(plan.tasks[i].type).toBe('A');
        }
      }
    });
  });
});
