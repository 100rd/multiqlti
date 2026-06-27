const { EnvironmentRouter } = require('../../src/env-router');
const { ValidationError, RestrictedEnvironmentError } = require('../../src/errors');

describe('EnvironmentRouter - Adversarial Test Suite', () => {
  let router;

  beforeEach(() => {
    router = new EnvironmentRouter();
    // Clean up prototype pollution if any test polluted it
    delete Object.prototype.id;
    delete Object.prototype.type;
    delete Object.prototype.authorizedAs;
    delete Object.prototype.loadScaleTesting;
    delete Object.prototype.env;
    delete Object.prototype.query;
  });

  afterEach(() => {
    // Clean up prototype pollution
    delete Object.prototype.id;
    delete Object.prototype.type;
    delete Object.prototype.authorizedAs;
    delete Object.prototype.loadScaleTesting;
    delete Object.prototype.env;
    delete Object.prototype.query;
  });

  describe('Prototype Pollution Defenses', () => {
    it('should throw ValidationError if Object.prototype has polluted critical fields', () => {
      // Simulate prototype pollution
      Object.prototype.type = 'D';
      
      const task = { id: 'task-1' }; // missing type, but polluted proto would provide 'D'
      const context = { env: 'Prod', query: 'DROP TABLE users;' };
      
      expect(() => router.route(task, context)).toThrow(ValidationError);
      expect(() => router.route(task, context)).toThrow('Prototype pollution');
    });

    it('should throw ValidationError if task object has polluted constructor properties', () => {
      const task = JSON.parse('{"id":"task-1", "type":"A", "__proto__":{"loadScaleTesting":true}}');
      const context = { env: 'Persistent', query: 'SELECT 1;' };
      
      // In JavaScript, JSON.parse doesn't pollute Object.prototype unless explicitly assigned,
      // but it creates custom prototypes or we want to ensure task has prototype pollution detected.
      const pollutedTask = Object.create(
        Object.create(Object.prototype, {
          loadScaleTesting: { value: true, enumerable: true }
        }),
        {
          id: { value: 'task-1', enumerable: true },
          type: { value: 'A', enumerable: true }
        }
      );
      
      expect(() => router.route(pollutedTask, context)).toThrow(ValidationError);
      expect(() => router.route(pollutedTask, context)).toThrow('Prototype pollution detected');
    });
  });

  describe('ES6 Proxy and Getter (TOCTOU) Defenses', () => {
    it('should throw ValidationError if task is a Proxy', () => {
      const target = { id: 'task-1', type: 'A' };
      const proxyTask = new Proxy(target, {});
      const context = { env: 'Prod', query: 'SELECT 1;' };
      
      expect(() => router.route(proxyTask, context)).toThrow(ValidationError);
      expect(() => router.route(proxyTask, context)).toThrow('must not be a Proxy');
    });

    it('should throw ValidationError if executionContext is a Proxy', () => {
      const task = { id: 'task-1', type: 'A' };
      const targetContext = { env: 'Prod', query: 'SELECT 1;' };
      const proxyContext = new Proxy(targetContext, {});
      
      expect(() => router.route(task, proxyContext)).toThrow(ValidationError);
      expect(() => router.route(task, proxyContext)).toThrow('must not be a Proxy');
    });

    it('should throw ValidationError if query in routeExecution is a Proxy', () => {
      const task = { id: 'task-1', type: 'A' };
      const proxyQuery = new Proxy(new String('SELECT 1;'), {});
      
      expect(() => router.routeExecution(task, 'Prod', proxyQuery)).toThrow(ValidationError);
      expect(() => router.routeExecution(task, 'Prod', proxyQuery)).toThrow('Query cannot be a Proxy');
    });

    it('should throw ValidationError if critical task property is an accessor (getter/setter)', () => {
      let count = 0;
      const taskWithGetter = {
        id: 'task-1',
        get type() {
          // Dynamic type getter attempt to return 'D' on second call (TOCTOU)
          count++;
          return count === 1 ? 'A' : 'D';
        }
      };
      const context = { env: 'Prod', query: 'DROP TABLE users;' };
      
      expect(() => router.route(taskWithGetter, context)).toThrow(ValidationError);
      expect(() => router.route(taskWithGetter, context)).toThrow('must be a data descriptor, not an accessor');
    });

    it('should throw ValidationError if critical executionContext property is an accessor', () => {
      const task = { id: 'task-1', type: 'A' };
      const contextWithGetter = {
        env: 'Prod',
        get query() {
          return 'DROP TABLE users;';
        }
      };
      
      expect(() => router.route(task, contextWithGetter)).toThrow(ValidationError);
      expect(() => router.route(task, contextWithGetter)).toThrow('must be a data descriptor, not an accessor');
    });
  });

  describe('Unicode & Null-Byte Obfuscation Defenses', () => {
    const taskNotD = { id: 'task-1', type: 'A' };

    it('should reject queries with null bytes', () => {
      expect(() => router.route(taskNotD, { env: 'Prod', query: 'SELECT * FROM users;\u0000DROP TABLE users;' })).toThrow(ValidationError);
      expect(() => router.route(taskNotD, { env: 'Prod', query: 'SELECT * FROM users;\u0000DROP TABLE users;' })).toThrow('null bytes');
    });

    it('should reject queries containing Cyrillic homoglyphs', () => {
      // Cyrillic 'о' (\u043e) instead of Latin 'o' in 'drop'
      const obfuscatedQuery = 'dr\u043ep table users;'; 
      expect(() => router.route(taskNotD, { env: 'Prod', query: obfuscatedQuery })).toThrow(ValidationError);
      expect(() => router.route(taskNotD, { env: 'Prod', query: obfuscatedQuery })).toThrow('Cyrillic homoglyphs');
    });

    it('should reject environment containing Cyrillic homoglyphs', () => {
      // Cyrillic 'о' in 'Prod' -> 'Pr\u043ed'
      const obfuscatedEnv = 'Pr\u043ed';
      expect(() => router.route(taskNotD, { env: obfuscatedEnv, query: 'SELECT 1;' })).toThrow(ValidationError);
      expect(() => router.route(taskNotD, { env: obfuscatedEnv, query: 'SELECT 1;' })).toThrow('Cyrillic homoglyphs');
    });

    it('should normalize Greek homoglyphs to ASCII and reject destructive queries', () => {
      // Greek omicron (\u03bf) instead of Latin 'o' in 'drop' -> 'dr\u03bfp table users;'
      const greekObfuscatedQuery = 'dr\u03bfp table users;';
      
      // Since it has a Greek homoglyph (not Cyrillic), it shouldn't be rejected immediately
      // but should normalize to 'drop table users;' and then throw RestrictedEnvironmentError on Prod!
      expect(() => router.route(taskNotD, { env: 'Prod', query: greekObfuscatedQuery })).toThrow(RestrictedEnvironmentError);
    });

    it('should normalize Fullwidth Latin homoglyphs to ASCII and reject destructive queries', () => {
      // Fullwidth 'd', 'r', 'o', 'p' (\uff44, \uff52, \uff4f, \uff50)
      const fullwidthQuery = '\uff44\uff52\uff4f\uff50 table users;';
      
      expect(() => router.route(taskNotD, { env: 'Prod', query: fullwidthQuery })).toThrow(RestrictedEnvironmentError);
    });
  });
});
