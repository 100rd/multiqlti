const { EnvironmentRouter } = require('../../src/env-router');
const { ValidationError, RestrictedEnvironmentError } = require('../../src/errors');

describe('EnvironmentRouter - Adversarial Bypass Test Suite', () => {
  let router;
  const taskNotD = { id: 'task-1', type: 'A' };

  beforeEach(() => {
    router = new EnvironmentRouter();
  });

  describe('Adversarial Bypasses for Query Normalizer', () => {
    it('Bypass 1: Standard-Conforming Strings (PostgreSQL Backslash Quote Bypass)', () => {
      const query = "SELECT 'a\\' ; DROP TABLE users; SELECT 'b';";
      expect(() => router.route(taskNotD, { env: 'Prod', query })).toThrow(RestrictedEnvironmentError);
    });

    it('Bypass 2: MySQL Executable Comments Bypass', () => {
      const query = "/*! DROP TABLE users */";
      expect(() => router.route(taskNotD, { env: 'Prod', query })).toThrow(ValidationError);
    });

    it('Bypass 3: Dynamic SQL Execution Bypass (PostgreSQL DO Block)', () => {
      const query = "DO $$ BEGIN EXECUTE 'DR' || 'OP TABLE users'; END $$;";
      expect(() => router.route(taskNotD, { env: 'Prod', query })).toThrow(RestrictedEnvironmentError);
    });

    it('Bypass 4: Dynamic SQL Execution Bypass (MySQL PREPARE/EXECUTE)', () => {
      const query = "SET @s = CONCAT('DR', 'OP TABLE users'); PREPARE stmt FROM @s; EXECUTE stmt;";
      expect(() => router.route(taskNotD, { env: 'Prod', query })).toThrow(RestrictedEnvironmentError);
    });
  });
});
