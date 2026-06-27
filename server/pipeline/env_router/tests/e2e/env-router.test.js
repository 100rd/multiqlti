const { EnvironmentRouter } = require('../../src/env-router');
const { ValidationError, RestrictedEnvironmentError } = require('../../src/errors');

describe('EnvironmentRouter - E2E Test Suite', () => {
  let router;

  beforeEach(() => {
    router = new EnvironmentRouter();
  });

  describe('Invalid parameter validations', () => {
    it('should throw ValidationError if task is invalid or not an object', () => {
      expect(() => router.route(null, { env: 'Ephemeral', query: 'SELECT 1;' })).toThrow(ValidationError);
      expect(() => router.route('not-an-object', { env: 'Ephemeral', query: 'SELECT 1;' })).toThrow(ValidationError);
      expect(() => router.route([], { env: 'Ephemeral', query: 'SELECT 1;' })).toThrow(ValidationError);
    });

    it('should throw ValidationError if executionContext is invalid or not an object', () => {
      const task = { id: 'task-1', type: 'A' };
      expect(() => router.route(task, null)).toThrow(ValidationError);
      expect(() => router.route(task, 'not-an-object')).toThrow(ValidationError);
      expect(() => router.route(task, [])).toThrow(ValidationError);
    });

    it('should throw ValidationError if task missing id or type', () => {
      expect(() => router.route({ type: 'A' }, { env: 'Ephemeral', query: 'SELECT 1;' })).toThrow(ValidationError);
      expect(() => router.route({ id: 'task-1' }, { env: 'Ephemeral', query: 'SELECT 1;' })).toThrow(ValidationError);
      expect(() => router.route({ id: '', type: 'A' }, { env: 'Ephemeral', query: 'SELECT 1;' })).toThrow(ValidationError);
    });

    it('should throw ValidationError if env is missing or not a string', () => {
      const task = { id: 'task-1', type: 'A' };
      expect(() => router.route(task, { query: 'SELECT 1;' })).toThrow(ValidationError);
      expect(() => router.route(task, { env: 123, query: 'SELECT 1;' })).toThrow(ValidationError);
    });

    it('should throw ValidationError if env value is invalid', () => {
      const task = { id: 'task-1', type: 'A' };
      expect(() => router.route(task, { env: 'Staging', query: 'SELECT 1;' })).toThrow(ValidationError);
    });

    it('should throw ValidationError if query is missing or empty', () => {
      const task = { id: 'task-1', type: 'A' };
      expect(() => router.route(task, { env: 'Ephemeral' })).toThrow(ValidationError);
      expect(() => router.route(task, { env: 'Ephemeral', query: '   ' })).toThrow(ValidationError);
    });
  });

  describe('Environment Constraint Matrix - Ephemeral', () => {
    const task = { id: 'task-1', type: 'A' };

    it('should authorize safe query in Ephemeral', () => {
      expect(router.route(task, { env: 'Ephemeral', query: 'SELECT * FROM users;' })).toBe(true);
    });

    it('should authorize destructive query in Ephemeral without restrictions', () => {
      expect(router.route(task, { env: 'Ephemeral', query: 'DROP TABLE users;' })).toBe(true);
      expect(router.route(task, { env: 'ephemeral', query: 'DELETE FROM users;' })).toBe(true);
    });

    it('should authorize Ephemeral access even if loadScaleTesting is false', () => {
      const ephemTask = { id: 'task-1', type: 'A', loadScaleTesting: false };
      expect(router.route(ephemTask, { env: 'Ephemeral', query: 'DROP TABLE users;' })).toBe(true);
    });
  });

  describe('Environment Constraint Matrix - Persistent', () => {
    it('should throw ValidationError if loadScaleTesting is not true', () => {
      const taskWithoutScale = { id: 'task-1', type: 'A', loadScaleTesting: false };
      expect(() => router.route(taskWithoutScale, { env: 'Persistent', query: 'SELECT * FROM users;' })).toThrow(ValidationError);
      expect(() => router.route(taskWithoutScale, { env: 'Persistent', query: 'SELECT * FROM users;' })).toThrow('load/scale testing');
    });

    it('should authorize safe queries in Persistent if loadScaleTesting is true', () => {
      const taskWithScale = { id: 'task-1', type: 'A', loadScaleTesting: true };
      expect(router.route(taskWithScale, { env: 'Persistent', query: 'SELECT * FROM users;' })).toBe(true);
    });

    it('should throw RestrictedEnvironmentError for destructive queries if task is not Type D', () => {
      const taskWithScaleNotD = { id: 'task-1', type: 'A', loadScaleTesting: true };
      expect(() => router.route(taskWithScaleNotD, { env: 'Persistent', query: 'DROP TABLE users;' })).toThrow(RestrictedEnvironmentError);
      expect(() => router.route(taskWithScaleNotD, { env: 'Persistent', query: 'DELETE FROM users;' })).toThrow(RestrictedEnvironmentError);
    });

    it('should authorize destructive queries in Persistent if task is Type D', () => {
      const taskWithScaleD = { id: 'task-1', type: 'D', loadScaleTesting: true };
      expect(router.route(taskWithScaleD, { env: 'Persistent', query: 'DROP TABLE users;' })).toBe(true);
      expect(router.route(taskWithScaleD, { env: 'Persistent', query: 'DELETE FROM users;' })).toBe(true);
    });
  });

  describe('Environment Constraint Matrix - Prod', () => {
    it('should authorize safe queries in Prod even without loadScaleTesting', () => {
      const taskNotD = { id: 'task-1', type: 'A' };
      expect(router.route(taskNotD, { env: 'Prod', query: 'SELECT * FROM users;' })).toBe(true);
    });

    it('should throw RestrictedEnvironmentError for destructive queries if task is not Type D', () => {
      const taskNotD = { id: 'task-1', type: 'A' };
      expect(() => router.route(taskNotD, { env: 'Prod', query: 'DROP TABLE users;' })).toThrow(RestrictedEnvironmentError);
      expect(() => router.route(taskNotD, { env: 'Prod', query: 'UPDATE users SET name = "bob";' })).toThrow(RestrictedEnvironmentError);
    });

    it('should authorize destructive queries in Prod if task is Type D', () => {
      const taskD = { id: 'task-1', type: 'D' };
      expect(router.route(taskD, { env: 'Prod', query: 'DROP TABLE users;' })).toBe(true);
      expect(router.route(taskD, { env: 'Prod', query: 'UPDATE users SET name = "bob";' })).toBe(true);
    });
  });

  describe('Case insensitivity and Normalization', () => {
    it('should support case-insensitive environment matching', () => {
      const task = { id: 'task-1', type: 'A' };
      expect(router.route(task, { env: 'ePhEmErAl', query: 'SELECT * FROM users;' })).toBe(true);
      
      const taskWithScale = { id: 'task-1', type: 'A', loadScaleTesting: true };
      expect(router.route(taskWithScale, { env: 'pErSiStEnT', query: 'SELECT * FROM users;' })).toBe(true);
      
      expect(router.route(task, { env: 'pRoD', query: 'SELECT * FROM users;' })).toBe(true);
    });

    it('should normalize and detect uppercase/lowercase SQL keywords', () => {
      const taskNotD = { id: 'task-1', type: 'A' };
      expect(() => router.route(taskNotD, { env: 'Prod', query: 'drop table users;' })).toThrow(RestrictedEnvironmentError);
      expect(() => router.route(taskNotD, { env: 'Prod', query: 'Drop Table users;' })).toThrow(RestrictedEnvironmentError);
      expect(() => router.route(taskNotD, { env: 'Prod', query: 'ALTER TABLE users ADD COLUMN age INT;' })).toThrow(RestrictedEnvironmentError);
    });
  });

  describe('Safe queries containing substring keywords or comments', () => {
    const taskNotD = { id: 'task-1', type: 'A' };

    it('should authorize queries with substring keywords that are not word boundaries', () => {
      expect(router.route(taskNotD, { env: 'Prod', query: 'SELECT * FROM users WHERE drop_table_id = 5;' })).toBe(true);
      expect(router.route(taskNotD, { env: 'Prod', query: 'SELECT * FROM users WHERE user_update_time > 1000;' })).toBe(true);
      expect(router.route(taskNotD, { env: 'Prod', query: 'SELECT alter_column FROM table_alteration;' })).toBe(true);
    });

    it('should strip comments and ignore destructive commands inside them', () => {
      expect(router.route(taskNotD, { env: 'Prod', query: 'SELECT * FROM users; -- drop table' })).toBe(true);
      expect(router.route(taskNotD, { env: 'Prod', query: 'SELECT * FROM users; /* alter table */' })).toBe(true);
    });

    it('should strip string literals and ignore destructive commands inside quotes/backticks', () => {
      expect(router.route(taskNotD, { env: 'Prod', query: "SELECT 'drop table users' FROM logs;" })).toBe(true);
      expect(router.route(taskNotD, { env: 'Prod', query: 'SELECT "alter table users" FROM logs;' })).toBe(true);
      expect(router.route(taskNotD, { env: 'Prod', query: 'SELECT `drop` FROM logs;' })).toBe(true);
    });
  });

  describe('routeExecution Helper', () => {
    it('should route correctly using routeExecution entry point', () => {
      const task = { id: 'task-1', type: 'A' };
      expect(router.routeExecution(task, 'Ephemeral', 'DROP TABLE users;')).toBe(true);
      
      const taskNotD = { id: 'task-1', type: 'A' };
      expect(() => router.routeExecution(taskNotD, 'Prod', 'DROP TABLE users;')).toThrow(RestrictedEnvironmentError);
    });
  });

  describe('Security Patches Assertions', () => {
    const taskNotD = { id: 'task-1', type: 'A' };

    it('should block comment bypasses like DROP/**/TABLE', () => {
      expect(() => router.route(taskNotD, { env: 'Prod', query: 'DROP/**/TABLE users;' })).toThrow(RestrictedEnvironmentError);
    });

    it('should throw ValidationError for MySQL executable comments', () => {
      expect(() => router.route(taskNotD, { env: 'Prod', query: '/*! DROP TABLE users */' })).toThrow(ValidationError);
    });

    it('should block underscore keywords like drop_table', () => {
      expect(() => router.route(taskNotD, { env: 'Prod', query: 'SELECT * FROM users; drop_table(x);' })).toThrow(RestrictedEnvironmentError);
    });

    it('should block dynamic SQL keywords', () => {
      expect(() => router.route(taskNotD, { env: 'Prod', query: 'prepare stmt from "select 1";' })).toThrow(RestrictedEnvironmentError);
      expect(() => router.route(taskNotD, { env: 'Prod', query: 'execute stmt;' })).toThrow(RestrictedEnvironmentError);
    });

    it('should throw ValidationError for Unicode homoglyphs (non-ASCII) in keywords', () => {
      expect(() => router.route(taskNotD, { env: 'Prod', query: 'crea\u03a4e table users;' })).toThrow(ValidationError);
    });

    it('should throw ValidationError for nested Proxy TOCTOU traps', () => {
      const task = {
        id: 'task-1',
        type: 'A',
        nested: new Proxy({}, {
          getPrototypeOf() {
            return Object.prototype;
          }
        })
      };
      expect(() => router.route(task, { env: 'Prod', query: 'SELECT 1;' })).toThrow(ValidationError);
    });
  });
});
