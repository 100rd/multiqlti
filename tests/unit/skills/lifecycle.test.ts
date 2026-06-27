import { MockContourObservabilityService } from './mock-observability';
import { describe, test, expect, beforeEach } from 'vitest';
import { 
  SkillLifecycleManager, 
  RequiresHumanAdmission, 
  LifecycleSkill 
} from '../../../server/pipeline/skills/skill-lifecycle-manager';

describe('LifecycleSkill Lifecycle and Admission Gate Verification (R1, R2, R4)', () => {
  let obsService: MockContourObservabilityService;
  let manager: SkillLifecycleManager;

  beforeEach(() => {
    obsService = new MockContourObservabilityService();
    manager = new SkillLifecycleManager(obsService);
  });

  test('New skills must default to quarantine stage', () => {
    const testSkill: LifecycleSkill = {
      id: 'skill-alpha',
      stage: 'versioned', // Attempts to start as versioned
      successDelta: 1.0,
      tags: [],
      code: 'console.log("hello world");',
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };

    manager.registerSkill(testSkill);
    const registered = manager.getSkillState('skill-alpha');

    expect(registered).toBeDefined();
    // Must be forced to quarantine stage
    expect(registered?.stage).toBe('quarantine');
  });

  test('Executing quarantined skill without override throws RequiresHumanAdmission', async () => {
    const testSkill: LifecycleSkill = {
      id: 'skill-beta',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: [],
      code: 'console.log("running beta");',
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };
    manager.registerSkill(testSkill);

    // Assert executing without flags rejects with RequiresHumanAdmission error
    await expect(
      manager.executeSkill('skill-beta', false, false)
    ).rejects.toThrow(RequiresHumanAdmission);
  });

  test('Golden-set run executes quarantine skill and promotes to versioned', async () => {
    const testSkill: LifecycleSkill = {
      id: 'skill-gamma',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: [],
      code: 'console.log("running gamma");',
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };
    manager.registerSkill(testSkill);

    // Running as isGoldenSet = true should bypass and promote
    const result = await manager.executeSkill('skill-gamma', false, true);
    expect(result.status).toBe('executed');

    const updated = manager.getSkillState('skill-gamma');
    expect(updated?.stage).toBe('versioned');
  });

  test('Bypassing human gate executes quarantine skill and promotes to versioned', async () => {
    const testSkill: LifecycleSkill = {
      id: 'skill-delta',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: [],
      code: 'console.log("running delta");',
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };
    manager.registerSkill(testSkill);

    // bypassHumanGate = true should succeed and promote
    const result = await manager.executeSkill('skill-delta', true, false);
    expect(result.status).toBe('executed');

    const updated = manager.getSkillState('skill-delta');
    expect(updated?.stage).toBe('versioned');
  });

  test('Degrading success-delta below 80% triggers transition to deprecated', async () => {
    const testSkill: LifecycleSkill = {
      id: 'skill-epsilon',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: [],
      code: 'console.log("running epsilon");',
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };
    manager.registerSkill(testSkill);
    
    // Promote to versioned first via golden run
    await manager.executeSkill('skill-epsilon', false, true);
    
    // Execute versioned to transition to success-delta (monitoring) stage
    await manager.executeSkill('skill-epsilon', false, false);
    expect(manager.getSkillState('skill-epsilon')?.stage).toBe('success-delta');

    // Simulate drift metrics falling to 78% (0.78)
    obsService.trackSkillSuccessRate('skill-epsilon', 0.78);

    // Verify it automatically changed to deprecated
    const updated = manager.getSkillState('skill-epsilon');
    expect(updated?.stage).toBe('deprecated');
    
    // Execution must now be fully blocked
    await expect(
      manager.executeSkill('skill-epsilon', false, false)
    ).rejects.toThrow(/Execution Denied/);
  });

  test('R1: State transitions follow strict flow constraints', () => {
    const skill: LifecycleSkill = {
      id: 'transition-skill',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: ['zone:green'],
      code: 'console.log("transitions");',
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };
    manager.registerSkill(skill);

    // Quarantine -> Versioned (Valid)
    expect(() => manager.transitionTo('transition-skill', 'versioned')).not.toThrow();

    // Versioned -> Success-Delta (Valid)
    expect(() => manager.transitionTo('transition-skill', 'success-delta')).not.toThrow();

    // Success-Delta -> Deprecated (Valid)
    expect(() => manager.transitionTo('transition-skill', 'deprecated')).not.toThrow();

    // Deprecated -> Versioned (Invalid: terminal stage check)
    expect(() => manager.transitionTo('transition-skill', 'versioned')).toThrow();
  });

  test('R1: success-delta can transition back to versioned for upgrade', () => {
    const upgradeSkill: LifecycleSkill = {
      id: 'upgrade-skill',
      stage: 'quarantine',
      successDelta: 1.0,
      tags: ['zone:green'],
      code: 'console.log("upgrade");',
      meta: {},
      version: '1.0.0',
      provenance: 'human',
      validatedModel: 'gpt-4',
      validatedEnv: 'test'
    };
    manager.registerSkill(upgradeSkill);
    manager.transitionTo('upgrade-skill', 'versioned');
    manager.transitionTo('upgrade-skill', 'success-delta');

    // success-delta -> versioned (Valid for upgrade)
    expect(() => manager.transitionTo('upgrade-skill', 'versioned')).not.toThrow();
    expect(manager.getSkillState('upgrade-skill')?.stage).toBe('versioned');
  });
});
