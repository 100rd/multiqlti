const { EnvironmentRouter } = require('../../src/env-router');
const { ValidationError, RestrictedEnvironmentError } = require('../../src/errors');

describe('EnvironmentRouter - Advanced Adversarial TOCTOU and Unicode Bypass', () => {
  let router;

  beforeEach(() => {
    router = new EnvironmentRouter();
  });

  it('should not bypass the type check using nested Proxy TOCTOU', () => {
    // 1. Create a task with type 'A' initially to pass descriptor check
    const task = {
      id: 'task-1',
      type: 'A',
      loadScaleTesting: true
    };

    // 2. Create a proxy and nest it under a non-critical property 'nested'
    const handler = {
      getPrototypeOf(target) {
        // This trap runs during hasPrototypePollution(task.nested)
        // Modify task.type to 'D' AFTER descriptor check but BEFORE use!
        task.type = 'D';
        return Object.prototype;
      }
    };
    const proxy = new Proxy({}, handler);
    task.nested = proxy;

    const context = {
      env: 'Prod',
      query: 'DROP TABLE users;'
    };

    // 3. Since type is changed to 'D' mid-flight, this should not pass and throw ValidationError!
    expect(() => router.route(task, context)).toThrow(ValidationError);
  });

  it('should not bypass the destructive keyword detection using Greek capital Tau', () => {
    const taskNotD = { id: 'task-1', type: 'A' };
    
    // Greek capital Tau (\u03a4) looks like 'T' but is not normalized to 'T' by NFKD or HOMOGLYPH_MAP.
    // So 'crea\u03a4e' becomes 'crea\u03a4e' which doesn't match 'create' in the regex!
    const query = 'crea\u03a4e table users;';

    // This query is destructive and should throw ValidationError
    expect(() => router.route(taskNotD, { env: 'Prod', query })).toThrow(ValidationError);
  });
});
