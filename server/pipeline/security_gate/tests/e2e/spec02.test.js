/**
 * SPEC-02: Zone-Based Security Gate and Proof Multiplicity Evaluator
 * E2E Test Suite
 */

const { SecurityGate } = require('../../src/security-gate');
const { ProofRouter } = require('../../src/proof-router');
const { ValidationError, RequiresHumanApproval } = require('../../src/errors');

describe('SPEC-02 E2E Test Suite', () => {
  let router;

  beforeEach(() => {
    router = new ProofRouter();
  });

  describe('Tier 1: Feature Coverage (25 Tests)', () => {
    describe('Feature 1.1: Security gate database migration rejection', () => {
      test('T1_SG_MIG_01: Type E task authorized as Type A is rejected', () => {
        const plan = {
          tasks: [{ id: 't-1', type: 'E', description: 'Update tables', authorizedAs: 'A' }]
        };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
      });

      test('T1_SG_MIG_02: Type A task with lowercase "database migration" description authorized as Type A is rejected', () => {
        const plan = {
          tasks: [{ id: 't-2', type: 'A', description: 'run database migration scripts', authorizedAs: 'A' }]
        };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
      });

      test('T1_SG_MIG_03: Type A task with uppercase "DATABASE MIGRATION" description authorized as Type A is rejected', () => {
        const plan = {
          tasks: [{ id: 't-3', type: 'C', description: 'RUN DATABASE MIGRATION LOGS', authorizedAs: 'A' }]
        };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
      });

      test('T1_SG_MIG_04: Type E task authorized as Type E is allowed to proceed', () => {
        const plan = {
          tasks: [{ id: 't-4', type: 'E', description: 'Database updates', authorizedAs: 'E' }]
        };
        expect(SecurityGate.verifyPlan(plan)).toBe(true);
      });

      test('T1_SG_MIG_05: Description contains "database migration" but authorized as Type E is allowed', () => {
        const plan = {
          tasks: [{ id: 't-5', type: 'E', description: 'database migration runs', authorizedAs: 'E' }]
        };
        expect(SecurityGate.verifyPlan(plan)).toBe(true);
      });

      test('T1_SG_MIG_06: Multiple tasks: one task violating (Type E authorized as A) causes plan rejection', () => {
        const plan = {
          tasks: [
            { id: 't-6a', type: 'B', description: 'UI test', authorizedAs: 'B' },
            { id: 't-6b', type: 'E', description: 'migration', authorizedAs: 'A' }
          ]
        };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
      });

      test('T1_SG_MIG_07: Multiple tasks: one task violating ("database migration" desc authorized as A) causes plan rejection', () => {
        const plan = {
          tasks: [
            { id: 't-7a', type: 'A', description: 'database migration test', authorizedAs: 'A' },
            { id: 't-7b', type: 'A', description: 'clean cache', authorizedAs: 'A' }
          ]
        };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
      });
    });

    describe('Feature 1.2: Security gate Type D requires human approval exception', () => {
      test('T1_SG_HIL_01: Type D task authorized as Type D is rejected for human approval', () => {
        const plan = {
          tasks: [{ id: 't-hil-1', type: 'D', description: 'Manual approval', authorizedAs: 'D' }]
        };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(RequiresHumanApproval);
      });

      test('T1_SG_HIL_02: Type D task authorized as Type A is rejected for human approval', () => {
        const plan = {
          tasks: [{ id: 't-hil-2', type: 'D', description: 'Manual verification', authorizedAs: 'A' }]
        };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(RequiresHumanApproval);
      });

      test('T1_SG_HIL_03: Multiple tasks: contains a valid task followed by a Type D task throws HIL error', () => {
        const plan = {
          tasks: [
            { id: 't-ok', type: 'A', description: 'Linting', authorizedAs: 'A' },
            { id: 't-hil-3', type: 'D', description: 'Approve build', authorizedAs: 'D' }
          ]
        };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(RequiresHumanApproval);
      });

      test('T1_SG_HIL_04: Multiple tasks: contains both Type D task and unauthorized Type E task throws correct error', () => {
        const plan = {
          tasks: [
            { id: 't-mig', type: 'E', description: 'Migrate DB', authorizedAs: 'A' },
            { id: 't-hil-4', type: 'D', description: 'Approve', authorizedAs: 'D' }
          ]
        };
        // It could throw ValidationError or RequiresHumanApproval depending on evaluation order,
        // but both are expected types of errors. We check for either.
        expect(() => SecurityGate.verifyPlan(plan)).toThrow();
      });

      test('T1_SG_HIL_05: Type D task with empty description throws HIL error', () => {
        const plan = {
          tasks: [{ id: 't-hil-5', type: 'D', description: '', authorizedAs: 'D' }]
        };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(RequiresHumanApproval);
      });

      test('T1_SG_HIL_06: Plan without any Type D task (and no other violation) passes', () => {
        const plan = {
          tasks: [
            { id: 't-ok-1', type: 'B', description: 'Diff', authorizedAs: 'B' },
            { id: 't-ok-2', type: 'C', description: 'Compile', authorizedAs: 'C' }
          ]
        };
        expect(SecurityGate.verifyPlan(plan)).toBe(true);
      });
    });

    describe('Feature 1.3: Proof multiplicity router Type B missing pixel diff proof validation error', () => {
      test('T1_PR_B_01: Type B task with null proofPayload throws ValidationError', () => {
        const task = { id: 't-b-1', type: 'B' };
        expect(() => router.submitCompletedTask(task, null)).toThrow(ValidationError);
        expect(() => router.submitCompletedTask(task, null)).toThrow(/Missing pixel diff proof for Type B/);
      });

      test('T1_PR_B_02: Type B task with empty object proofPayload throws ValidationError', () => {
        const task = { id: 't-b-2', type: 'B' };
        expect(() => router.submitCompletedTask(task, {})).toThrow(ValidationError);
        expect(() => router.submitCompletedTask(task, {})).toThrow(/Missing pixel diff proof for Type B/);
      });

      test('T1_PR_B_03: Type B task with proof payload lacking pixel_diff field throws ValidationError', () => {
        const task = { id: 't-b-3', type: 'B' };
        expect(() => router.submitCompletedTask(task, { screenshot: 'hash' })).toThrow(ValidationError);
        expect(() => router.submitCompletedTask(task, { screenshot: 'hash' })).toThrow(/Missing pixel diff proof for Type B/);
      });

      test('T1_PR_B_04: Type B task with pixel_diff field present is valid', () => {
        const task = { id: 't-b-4', type: 'B' };
        expect(router.submitCompletedTask(task, { pixel_diff: 'diff_data' })).toBe(true);
      });

      test('T1_PR_B_05: Type B task with pixel_diff key present but set to null throws ValidationError', () => {
        const task = { id: 't-b-5', type: 'B' };
        expect(() => router.submitCompletedTask(task, { pixel_diff: null })).toThrow(ValidationError);
        expect(() => router.submitCompletedTask(task, { pixel_diff: null })).toThrow(/Missing pixel diff proof for Type B/);
      });

      test('T1_PR_B_06: Type B task with pixel_diff key present but set to undefined throws ValidationError', () => {
        const task = { id: 't-b-6', type: 'B' };
        expect(() => router.submitCompletedTask(task, { pixel_diff: undefined })).toThrow(ValidationError);
        expect(() => router.submitCompletedTask(task, { pixel_diff: undefined })).toThrow(/Missing pixel diff proof for Type B/);
      });
    });

    describe('Feature 1.4: Proof multiplicity router Type E missing rollback proof validation error', () => {
      test('T1_PR_E_01: Type E task with null proofPayload throws ValidationError', () => {
        const task = { id: 't-e-1', type: 'E' };
        expect(() => router.submitCompletedTask(task, null)).toThrow(ValidationError);
        expect(() => router.submitCompletedTask(task, null)).toThrow(/Missing rollback proof for Type E/);
      });

      test('T1_PR_E_02: Type E task with empty object proofPayload throws ValidationError', () => {
        const task = { id: 't-e-2', type: 'E' };
        expect(() => router.submitCompletedTask(task, {})).toThrow(ValidationError);
        expect(() => router.submitCompletedTask(task, {})).toThrow(/Missing rollback proof for Type E/);
      });

      test('T1_PR_E_03: Type E task with proof payload lacking rollback_script field throws ValidationError', () => {
        const task = { id: 't-e-3', type: 'E' };
        expect(() => router.submitCompletedTask(task, { migration_sql: 'sql' })).toThrow(ValidationError);
        expect(() => router.submitCompletedTask(task, { migration_sql: 'sql' })).toThrow(/Missing rollback proof for Type E/);
      });

      test('T1_PR_E_04: Type E task with rollback_script field present is valid', () => {
        const task = { id: 't-e-4', type: 'E' };
        expect(router.submitCompletedTask(task, { rollback_script: 'sql_rollback' })).toBe(true);
      });

      test('T1_PR_E_05: Type E task with rollback_script key present but set to null throws ValidationError', () => {
        const task = { id: 't-e-5', type: 'E' };
        expect(() => router.submitCompletedTask(task, { rollback_script: null })).toThrow(ValidationError);
        expect(() => router.submitCompletedTask(task, { rollback_script: null })).toThrow(/Missing rollback proof for Type E/);
      });

      test('T1_PR_E_06: Type E task with rollback_script key present but set to undefined throws ValidationError', () => {
        const task = { id: 't-e-6', type: 'E' };
        expect(() => router.submitCompletedTask(task, { rollback_script: undefined })).toThrow(ValidationError);
        expect(() => router.submitCompletedTask(task, { rollback_script: undefined })).toThrow(/Missing rollback proof for Type E/);
      });
    });
  });

  describe('Tier 2: Boundary & Corner Cases (22 Tests)', () => {
    describe('Feature 2.1: Security Gate - Empty/Null/Invalid Plan Payloads', () => {
      test('T2_SG_PLN_01: Plan is null throws ValidationError', () => {
        expect(() => SecurityGate.verifyPlan(null)).toThrow(ValidationError);
      });

      test('T2_SG_PLN_02: Plan is undefined throws ValidationError', () => {
        expect(() => SecurityGate.verifyPlan(undefined)).toThrow(ValidationError);
      });

      test('T2_SG_PLN_03: Plan is empty object {} throws ValidationError', () => {
        expect(() => SecurityGate.verifyPlan({})).toThrow(ValidationError);
      });

      test('T2_SG_PLN_04: Plan has tasks key but it is not an array throws ValidationError', () => {
        expect(() => SecurityGate.verifyPlan({ tasks: 'not-an-array' })).toThrow(ValidationError);
      });

      test('T2_SG_PLN_05: Plan has an empty tasks array is allowed (returns true)', () => {
        expect(SecurityGate.verifyPlan({ tasks: [] })).toBe(true);
      });
    });

    describe('Feature 2.2: Security Gate - Missing/Malformed Task Fields', () => {
      test('T2_SG_TSK_01: Tasks list contains null element throws ValidationError', () => {
        expect(() => SecurityGate.verifyPlan({ tasks: [null] })).toThrow(ValidationError);
      });

      test('T2_SG_TSK_02: Task is missing id field throws ValidationError', () => {
        const plan = {
          tasks: [{ type: 'A', description: 'Lint', authorizedAs: 'A' }]
        };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
      });

      test('T2_SG_TSK_03: Task is missing type field throws ValidationError', () => {
        const plan = {
          tasks: [{ id: 't-33', description: 'Lint', authorizedAs: 'A' }]
        };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
      });

      test('T2_SG_TSK_04: Task has invalid/unsupported type enum "X" throws ValidationError', () => {
        const plan = {
          tasks: [{ id: 't-34', type: 'X', description: 'Lint', authorizedAs: 'A' }]
        };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
      });

      test('T2_SG_TSK_05: Task is missing authorizedAs field throws ValidationError', () => {
        const plan = {
          tasks: [{ id: 't-35', type: 'A', description: 'Lint' }]
        };
        expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
      });

      test('T2_SG_TSK_06: Task has empty string description is allowed (returns true)', () => {
        const plan = {
          tasks: [{ id: 't-36', type: 'A', description: '', authorizedAs: 'A' }]
        };
        expect(SecurityGate.verifyPlan(plan)).toBe(true);
      });
    });

    describe('Feature 2.3: Proof Router - Null/Undefined/Malformed Input Payloads', () => {
      test('T2_PR_PAY_01: Task parameter is null throws ValidationError', () => {
        expect(() => router.submitCompletedTask(null, {})).toThrow(ValidationError);
      });

      test('T2_PR_PAY_02: Task is missing type field throws ValidationError', () => {
        expect(() => router.submitCompletedTask({ id: 't-38' }, {})).toThrow(ValidationError);
      });

      test('T2_PR_PAY_03: Task is missing id field throws ValidationError', () => {
        expect(() => router.submitCompletedTask({ type: 'B' }, { pixel_diff: 'diff' })).toThrow(ValidationError);
      });

      test('T2_PR_PAY_04: Task has invalid/unknown type enum "Z" throws ValidationError', () => {
        expect(() => router.submitCompletedTask({ id: 't-40', type: 'Z' }, {})).toThrow(ValidationError);
      });

      test('T2_PR_PAY_05: Both task and proofPayload parameters are null throws ValidationError', () => {
        expect(() => router.submitCompletedTask(null, null)).toThrow(ValidationError);
      });
    });

    describe('Feature 2.4: Proof Router - Boundary conditions for Proof validation', () => {
      test('T2_PR_PRF_01: Type A task submitted with null proof payload is allowed', () => {
        const task = { id: 't-42', type: 'A' };
        expect(router.submitCompletedTask(task, null)).toBe(true);
      });

      test('T2_PR_PRF_02: Type C task submitted with empty object is allowed', () => {
        const task = { id: 't-43', type: 'C' };
        expect(router.submitCompletedTask(task, {})).toBe(true);
      });

      test('T2_PR_PRF_03: Type B task with pixel_diff set to complex object is allowed', () => {
        const task = { id: 't-44', type: 'B' };
        expect(router.submitCompletedTask(task, { pixel_diff: { pct: 0.05 } })).toBe(true);
      });

      test('T2_PR_PRF_04: Type E task with rollback_script set to empty string is allowed', () => {
        const task = { id: 't-45', type: 'E' };
        expect(router.submitCompletedTask(task, { rollback_script: '' })).toBe(true);
      });

      test('T2_PR_PRF_05: Type D task with empty proof payload is allowed', () => {
        const task = { id: 't-46', type: 'D' };
        expect(router.submitCompletedTask(task, {})).toBe(true);
      });

      test('T2_PR_PRF_06: Type B task with extra metadata fields in proof is allowed', () => {
        const task = { id: 't-47', type: 'B' };
        expect(router.submitCompletedTask(task, { pixel_diff: 'diff', timestamp: 1234 })).toBe(true);
      });
    });
  });

  describe('Tier 3: Cross-Feature Combinations (11 Tests)', () => {
    test('T3_SG_MIX_01: Mixed Validity in a Single Plan (Security Gate)', () => {
      const plan = {
        tasks: [
          { id: 'task-1', type: 'A', description: 'Run standard unit tests', authorizedAs: 'A' },
          { id: 'task-2', type: 'B', description: 'Verify frontend UI pixel diffs', authorizedAs: 'B' },
          { id: 'task-3', type: 'E', description: 'Apply schema migration for transactions table', authorizedAs: 'A' }
        ]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('T3_SG_DESC_02: Implicit Type E via Description with Mixed Tasks', () => {
      const plan = {
        tasks: [
          { id: 'task-1', type: 'C', description: 'Run post-deploy database migration checks', authorizedAs: 'A' },
          { id: 'task-2', type: 'B', description: 'Visual verify homepage', authorizedAs: 'B' }
        ]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('T3_PR_PIPE_03: Sequential Plan-to-Proof Pipeline (Happy Path)', () => {
      const plan = {
        tasks: [
          { id: 't1', type: 'A', description: 'Run unit tests', authorizedAs: 'A' },
          { id: 't2', type: 'B', description: 'Visual layout check', authorizedAs: 'B' },
          { id: 't3', type: 'E', description: 'Database schema change', authorizedAs: 'E' }
        ]
      };
      expect(SecurityGate.verifyPlan(plan)).toBe(true);
      expect(router.submitCompletedTask(plan.tasks[0], {})).toBe(true);
      expect(router.submitCompletedTask(plan.tasks[1], { pixel_diff: 'data:image/png;base64,...' })).toBe(true);
      expect(router.submitCompletedTask(plan.tasks[2], { rollback_script: 'DROP TABLE audit_logs;' })).toBe(true);
    });

    test('T3_PR_PIPE_04: Pipeline with Post-Gate Proof Failure (Type B)', () => {
      const plan = {
        tasks: [
          { id: 't1', type: 'A', description: 'Build asset compilation', authorizedAs: 'A' },
          { id: 't2', type: 'B', description: 'Render homepage', authorizedAs: 'B' }
        ]
      };
      expect(SecurityGate.verifyPlan(plan)).toBe(true);
      expect(router.submitCompletedTask(plan.tasks[0], {})).toBe(true);
      expect(() => router.submitCompletedTask(plan.tasks[1], {})).toThrow(ValidationError);
      expect(() => router.submitCompletedTask(plan.tasks[1], {})).toThrow(/Missing pixel diff proof for Type B/);
    });

    test('T3_PR_PIPE_05: Pipeline with Post-Gate Proof Failure (Type E)', () => {
      const plan = {
        tasks: [
          { id: 't-migration', type: 'E', description: 'Database migration', authorizedAs: 'E' }
        ]
      };
      expect(SecurityGate.verifyPlan(plan)).toBe(true);
      expect(() => router.submitCompletedTask(plan.tasks[0], { some_other_key: 'data' })).toThrow(ValidationError);
      expect(() => router.submitCompletedTask(plan.tasks[0], { some_other_key: 'data' })).toThrow(/Missing rollback proof for Type E/);
    });

    test('T3_PR_FAIL_06: Double Proof-Validation Failure in Plan Execution', () => {
      const taskB = { id: 't-b', type: 'B' };
      const taskE = { id: 't-e', type: 'E' };

      expect(() => router.submitCompletedTask(taskB, {})).toThrow(ValidationError);
      expect(() => router.submitCompletedTask(taskB, {})).toThrow(/Missing pixel diff proof for Type B/);

      expect(() => router.submitCompletedTask(taskE, {})).toThrow(ValidationError);
      expect(() => router.submitCompletedTask(taskE, {})).toThrow(/Missing rollback proof for Type E/);
    });

    test('T3_SG_HIL_07: Boundary Combinatorial Plan - Large Scale with a Single Human-in-the-Loop Task', () => {
      const tasks = [];
      for (let i = 1; i <= 99; i++) {
        tasks.push({ id: `t-a-${i}`, type: 'A', description: 'Autonomous task', authorizedAs: 'A' });
      }
      tasks.push({ id: 't-d-100', type: 'D', description: 'Human-in-the-loop audit check', authorizedAs: 'D' });
      
      const plan = { tasks };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(RequiresHumanApproval);
    });

    test('T3_SG_PREC_08A: Evaluation Order and Exception Precedence Scenario A (Type E authorized as A first)', () => {
      const plan = {
        tasks: [
          { id: 't-bad-e', type: 'E', description: 'DB change', authorizedAs: 'A' },
          { id: 't-hil', type: 'D', description: 'Manual step', authorizedAs: 'D' }
        ]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('T3_SG_PREC_08B: Evaluation Order and Exception Precedence Scenario B (Type D first)', () => {
      const plan = {
        tasks: [
          { id: 't-hil', type: 'D', description: 'Manual step', authorizedAs: 'D' },
          { id: 't-bad-e', type: 'E', description: 'DB change', authorizedAs: 'A' }
        ]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(RequiresHumanApproval);
    });

    test('T3_SG_ZONE_09: Authorization Zone Permissiveness (Non-A Authorization Zones for Type E)', () => {
      const plan = {
        tasks: [
          { id: 't-migration-ok', type: 'E', description: 'Database schema migration', authorizedAs: 'E' },
          { id: 't-migration-b', type: 'E', description: 'Database migration script', authorizedAs: 'B' }
        ]
      };
      expect(SecurityGate.verifyPlan(plan)).toBe(true);
    });

    test('T3_PR_NONE_10: Multi-Task Plan with Type C and Type A (No Proofs Required)', () => {
      const taskA = { id: 'task-a', type: 'A' };
      const taskC = { id: 'task-c', type: 'C' };

      expect(router.submitCompletedTask(taskA, {})).toBe(true);
      expect(router.submitCompletedTask(taskC, null)).toBe(true);
    });
  });

  describe('Tier 4: Real-World Scenarios (4 Tests)', () => {
    test('T4_SC_HAPPY_01: Scenario 4.1: Happy Path Autonomous Release Pipeline (A -> B -> C)', () => {
      const plan = {
        tasks: [
          { id: 'task-happy-1', type: 'A', description: 'Compile sources and package artifact', authorizedAs: 'A' },
          { id: 'task-happy-2', type: 'B', description: 'Run visual regression diff on components', authorizedAs: 'B' },
          { id: 'task-happy-3', type: 'C', description: 'Verify license compliance of dependencies', authorizedAs: 'C' }
        ]
      };

      const gateResult = SecurityGate.verifyPlan(plan);
      expect(gateResult).toBe(true);

      const proofA = { artifact_hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' };
      expect(router.submitCompletedTask(plan.tasks[0], proofA)).toBe(true);

      const proofB = { pixel_diff: { mismatch_ratio: 0.0, total_pixels: 1024 } };
      expect(router.submitCompletedTask(plan.tasks[1], proofB)).toBe(true);

      const proofC = { license_check: 'passed', forbidden_licenses: [] };
      expect(router.submitCompletedTask(plan.tasks[2], proofC)).toBe(true);
    });

    test('T4_SC_GATE_02: Scenario 4.2: Manual Intervention and Stage Promotion (A -> D -> B)', () => {
      const plan = {
        tasks: [
          { id: 'task-gate-1', type: 'A', description: 'Compile staging build', authorizedAs: 'A' },
          { id: 'task-gate-2', type: 'D', description: 'Wait for QA engineer signoff', authorizedAs: 'D' },
          { id: 'task-gate-3', type: 'B', description: 'Verify visual layout on staging environment', authorizedAs: 'B' }
        ]
      };

      expect(() => {
        SecurityGate.verifyPlan(plan);
      }).toThrow(RequiresHumanApproval);

      const proofA = { compiled: true };
      expect(router.submitCompletedTask(plan.tasks[0], proofA)).toBe(true);

      const proofD = { operator_id: 'QA_USER_01', action: 'APPROVED' };
      expect(router.submitCompletedTask(plan.tasks[1], proofD)).toBe(true);

      const proofB = { pixel_diff: { mismatched_pixels: 0 } };
      expect(router.submitCompletedTask(plan.tasks[2], proofB)).toBe(true);
    });

    test('T4_SC_MIG_03: Scenario 4.3: Infrastructure Migration, Rollback Proof Enforcement, and Recovery (A -> E -> C)', () => {
      const plan = {
        tasks: [
          { id: 'task-db-1', type: 'A', description: 'Pull migration docker image', authorizedAs: 'A' },
          { id: 'task-db-2', type: 'E', description: 'Apply v2 schema changes to user database', authorizedAs: 'E' },
          { id: 'task-db-3', type: 'C', description: 'Verify post-migration database connection health', authorizedAs: 'C' }
        ]
      };

      expect(SecurityGate.verifyPlan(plan)).toBe(true);

      expect(router.submitCompletedTask(plan.tasks[0], { success: true })).toBe(true);

      expect(() => {
        router.submitCompletedTask(plan.tasks[1], { applied_migrations: ['001_init.sql'] });
      }).toThrow(ValidationError);

      try {
        router.submitCompletedTask(plan.tasks[1], { applied_migrations: ['001_init.sql'] });
      } catch (err) {
        expect(err.message).toContain('Missing rollback proof for Type E');
      }

      const validProofE = {
        applied_migrations: ['001_init.sql'],
        rollback_script: 'DROP TABLE users_v2; ALTER TABLE profiles DROP COLUMN age;'
      };
      expect(router.submitCompletedTask(plan.tasks[1], validProofE)).toBe(true);

      expect(router.submitCompletedTask(plan.tasks[2], { connection_pool_active: true })).toBe(true);
    });

    test('T4_SC_SPOOF_04: Scenario 4.4: Adversarial LLM Plan Spoofing & Security Intrusion Recovery', () => {
      const spoofPlan1 = {
        tasks: [
          {
            id: 'task-spoof-1',
            type: 'A',
            description: 'Perform database migration and clean legacy tables',
            authorizedAs: 'A'
          }
        ]
      };

      const spoofPlan2 = {
        tasks: [
          {
            id: 'task-spoof-2',
            type: 'E',
            description: 'Alter partition indexes',
            authorizedAs: 'A'
          }
        ]
      };

      expect(() => {
        SecurityGate.verifyPlan(spoofPlan1);
      }).toThrow(ValidationError);

      expect(() => {
        SecurityGate.verifyPlan(spoofPlan2);
      }).toThrow(ValidationError);
    });
  });
});
