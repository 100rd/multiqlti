/**
 * SPEC-02: Zone-Based Security Gate and Proof Multiplicity Evaluator
 * Adversarial Test Suite (Tier 5) - Secure Baseline
 */

const { SecurityGate } = require('../../src/security-gate');
const { ProofRouter } = require('../../src/proof-router');
const { ValidationError, RequiresHumanApproval } = require('../../src/errors');

describe('SPEC-02 Adversarial Test Suite - Secure', () => {
  let router;

  beforeEach(() => {
    router = new ProofRouter();
  });

  afterEach(() => {
    // Ensure prototype pollution is cleaned up between tests
    delete Object.prototype.authorizedAs;
    delete Object.prototype.description;
    delete Object.prototype.type;
    delete Object.prototype.id;
    delete Object.prototype.pixel_diff;
    delete Object.prototype.rollback_script;
  });

  describe('SecurityGate - Prototype Pollution & Object Injection', () => {
    test('ADV_SG_PP_01: Prototype pollution of authorizedAs does not bypass missing field validation', () => {
      const planBefore = {
        tasks: [{ id: 't-pp-1', type: 'E', description: 'DB changes' }]
      };
      expect(() => SecurityGate.verifyPlan(planBefore)).toThrow(ValidationError);

      Object.prototype.authorizedAs = 'E';

      try {
        const planAfter = {
          tasks: [{ id: 't-pp-1', type: 'E', description: 'DB changes' }]
        };
        // Should still throw ValidationError because authorizedAs is not an own property
        expect(() => SecurityGate.verifyPlan(planAfter)).toThrow(ValidationError);
      } finally {
        delete Object.prototype.authorizedAs;
      }
    });

    test('ADV_SG_PP_02: Prototype pollution of description does not cause DoS for Type A tasks', () => {
      Object.prototype.description = 'database migration';

      try {
        const plan = {
          tasks: [{ id: 't-pp-2', type: 'A', authorizedAs: 'A' }]
        };
        // The polluted description is not an own property, so it should be ignored.
        // Thus, the plan passes validation.
        expect(SecurityGate.verifyPlan(plan)).toBe(true);
      } finally {
        delete Object.prototype.description;
      }
    });

    test('ADV_SG_PP_03: Prototype pollution of type does not bypass missing type validation', () => {
      const planBefore = {
        tasks: [{ id: 't-pp-3', authorizedAs: 'A' }]
      };
      expect(() => SecurityGate.verifyPlan(planBefore)).toThrow(ValidationError);

      Object.prototype.type = 'A';

      try {
        const planAfter = {
          tasks: [{ id: 't-pp-3', authorizedAs: 'A' }]
        };
        expect(() => SecurityGate.verifyPlan(planAfter)).toThrow(ValidationError);
      } finally {
        delete Object.prototype.type;
      }
    });
  });

  describe('SecurityGate - Input Validation Bypass & Enums', () => {
    test('ADV_SG_BYP_01: Case-insensitivity/Enums bypass - lowercase authorizedAs is rejected', () => {
      const plan = {
        tasks: [{ id: 't-byp-1', type: 'E', description: 'Run migration', authorizedAs: 'a' }]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_SG_BYP_02: String bypass - unicode homoglyph in description is detected', () => {
      const plan = {
        tasks: [{ id: 't-byp-2', type: 'A', description: 'd\u0430t\u0430b\u0430s\u0435 migration', authorizedAs: 'A' }]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_SG_BYP_03: Object injection in description (toString bypass) is rejected', () => {
      const plan = {
        tasks: [{
          id: 't-byp-3',
          type: 'A',
          description: { toString: () => 'database migration' },
          authorizedAs: 'A'
        }]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_SG_BYP_04: Array injection in description bypasses check is rejected', () => {
      const plan = {
        tasks: [{
          id: 't-byp-4',
          type: 'A',
          description: ['database migration'],
          authorizedAs: 'A'
        }]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_SG_BYP_05: Whitespace in authorizedAs field is rejected', () => {
      const plan = {
        tasks: [{ id: 't-byp-5', type: 'E', description: 'Run migration', authorizedAs: 'A ' }]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });
  });

  describe('SecurityGate - Property Getter Mutation (TOCTOU & Stateful Spoofing)', () => {
    test('ADV_TOCTOU_01: Stateful getter on task.type does not bypass SecurityGate (throws ValidationError or HIL)', () => {
      let reads = 0;
      const task = {
        id: 't-spoof-e',
        authorizedAs: 'A',
        description: 'Normal task',
        get type() {
          reads++;
          if (reads <= 5) {
            return 'A';
          }
          return 'E';
        }
      };

      const plan = { tasks: [task] };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_TOCTOU_02: Stateful getter on task.type is rejected in SecurityGate', () => {
      let reads = 0;
      const task = {
        id: 't-spoof-hil',
        authorizedAs: 'A',
        description: 'Normal task',
        get type() {
          reads++;
          if (reads <= 5) {
            return 'A';
          }
          return 'D';
        }
      };

      const plan = { tasks: [task] };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });
  });

  describe('SecurityGate - Edge Cases, Nulls, and Types', () => {
    test('ADV_SG_ERR_01: Task is a Proxy that throws on access throws ValidationError', () => {
      const taskProxy = new Proxy({}, {
        get(target, prop) {
          throw new Error(`Simulated unexpected error for property: ${prop}`);
        }
      });
      const plan = { tasks: [taskProxy] };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_SG_TYP_02: Task id is a non-string type (number) is rejected', () => {
      const plan = {
        tasks: [{ id: 12345, type: 'A', description: 'Valid desc', authorizedAs: 'A' }]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_SG_TYP_03: Task authorizedAs is a non-string type (boolean) is rejected', () => {
      const plan = {
        tasks: [{ id: 't-typ-3', type: 'A', description: 'Valid desc', authorizedAs: true }]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });

    test('ADV_SG_TYP_04: Empty string task.id throws ValidationError', () => {
      const plan = {
        tasks: [{ id: '', type: 'A', description: 'Valid desc', authorizedAs: 'A' }]
      };
      expect(() => SecurityGate.verifyPlan(plan)).toThrow(ValidationError);
    });
  });

  describe('ProofRouter - Prototype Pollution & Object Injection', () => {
    test('ADV_PR_PP_01: Prototype pollution of pixel_diff is rejected', () => {
      const task = { id: 't-pr-pp-1', type: 'B' };
      expect(() => router.submitCompletedTask(task, {})).toThrow(ValidationError);

      Object.prototype.pixel_diff = 'polluted_diff';

      try {
        expect(() => router.submitCompletedTask(task, {})).toThrow(ValidationError);
      } finally {
        delete Object.prototype.pixel_diff;
      }
    });

    test('ADV_PR_PP_02: Prototype pollution of rollback_script is rejected', () => {
      const task = { id: 't-pr-pp-2', type: 'E' };
      expect(() => router.submitCompletedTask(task, {})).toThrow(ValidationError);

      Object.prototype.rollback_script = 'polluted_script';

      try {
        expect(() => router.submitCompletedTask(task, {})).toThrow(ValidationError);
      } finally {
        delete Object.prototype.rollback_script;
      }
    });
  });

  describe('ProofRouter - Edge Cases & Proxy Attacks', () => {
    test('ADV_PR_BYP_01: proofPayload is an array is rejected', () => {
      const task = { id: 't-pr-byp-1', type: 'B' };
      const proofPayload = [];
      proofPayload.pixel_diff = 'diff';

      expect(() => router.submitCompletedTask(task, proofPayload)).toThrow(ValidationError);
    });

    test('ADV_PR_BYP_02: proofPayload is a Proxy that throws on access throws ValidationError', () => {
      const task = { id: 't-pr-byp-2', type: 'B' };
      const proofPayloadProxy = new Proxy({}, {
        get(target, prop) {
          throw new Error(`Simulated unexpected error for property: ${prop}`);
        }
      });
      expect(() => router.submitCompletedTask(task, proofPayloadProxy)).toThrow(ValidationError);
    });

    test('ADV_PR_BYP_03: proofPayload has getter that returns different values is handled correctly', () => {
      const task = { id: 't-pr-byp-3', type: 'B' };
      let accessCount = 0;
      const proofPayload = {
        get pixel_diff() {
          accessCount++;
          return accessCount === 1 ? 'diff' : null;
        }
      };
      expect(() => router.submitCompletedTask(task, proofPayload)).toThrow(ValidationError);
    });
  });
});
