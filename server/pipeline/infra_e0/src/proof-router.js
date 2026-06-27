const util = require('util');
const { ValidationError, MissingRollbackProofError } = require('./errors');

class ProofRouter {
  submitCompletedTask(task, proofPayload) {
    try {
      if (!task || typeof task !== 'object' || Array.isArray(task)) {
        throw new ValidationError('Task is null or invalid');
      }

      if (util.types.isProxy(task)) {
        throw new ValidationError('Task cannot be a Proxy');
      }

      if (!Object.hasOwn(task, 'id')) {
        throw new ValidationError('Task is missing id field');
      }
      if (!Object.hasOwn(task, 'type')) {
        throw new ValidationError('Task is missing type field');
      }

      // Prevent TOCTOU / getter exploits
      for (const prop of ['id', 'type']) {
        let currentProto = task;
        while (currentProto && currentProto !== Object.prototype) {
          const desc = Object.getOwnPropertyDescriptor(currentProto, prop);
          if (desc && (desc.get || desc.set)) {
            throw new ValidationError(`Task property "${prop}" must be a data property, not an accessor`);
          }
          currentProto = Object.getPrototypeOf(currentProto);
        }
      }

      const taskId = task.id;
      const taskType = task.type;

      if (typeof taskId !== 'string' || taskId.trim() === '') {
        throw new ValidationError('Task id must be a non-empty string');
      }

      const allowedTypes = ['A', 'B', 'C', 'D', 'E'];
      if (typeof taskType !== 'string' || !allowedTypes.includes(taskType)) {
        throw new ValidationError(`Task has invalid/unknown type enum "${taskType}"`);
      }

      if (proofPayload && util.types.isProxy(proofPayload)) {
        throw new ValidationError('Proof payload cannot be a Proxy');
      }

      const targetProps = ['rollback_script', 'down_script', 'forward_script', 'up_script', 'smoke_tests'];
      if (proofPayload && typeof proofPayload === 'object') {
        for (const prop of targetProps) {
          let currentProto = proofPayload;
          let found = false;
          while (currentProto && currentProto !== Object.prototype) {
            if (Object.prototype.hasOwnProperty.call(currentProto, prop)) {
              found = true;
              const desc = Object.getOwnPropertyDescriptor(currentProto, prop);
              if (desc && (desc.get || desc.set)) {
                throw new ValidationError(`Proof payload property "${prop}" must be a data property, not an accessor`);
              }
            }
            currentProto = Object.getPrototypeOf(currentProto);
          }
          if (found) {
            const val = proofPayload[prop];
            if (val !== undefined && val !== null) {
              if (typeof val !== 'string') {
                throw new ValidationError(`Proof payload property "${prop}" must be a primitive string`);
              }
            }
          }
        }
      }

      if (taskType === 'B') {
        if (!proofPayload || typeof proofPayload !== 'object' || Array.isArray(proofPayload)) {
          throw new ValidationError('Missing pixel diff proof for Type B');
        }
        if (!Object.hasOwn(proofPayload, 'pixel_diff')) {
          throw new ValidationError('Missing pixel diff proof for Type B');
        }
        const desc = Object.getOwnPropertyDescriptor(proofPayload, 'pixel_diff');
        if (desc && (desc.get || desc.set)) {
          throw new ValidationError('Proof payload property "pixel_diff" must be a data property, not an accessor');
        }
        const pixelDiff = proofPayload.pixel_diff;
        if (pixelDiff === null || pixelDiff === undefined) {
          throw new ValidationError('Missing pixel diff proof for Type B');
        }
      } else if (taskType === 'E') {
        if (!proofPayload || typeof proofPayload !== 'object' || Array.isArray(proofPayload)) {
          throw new MissingRollbackProofError('Missing rollback proof for Type E');
        }

        // Validate accessor descriptors for all potential properties to prevent TOCTOU
        for (const prop of Object.getOwnPropertyNames(proofPayload)) {
          const desc = Object.getOwnPropertyDescriptor(proofPayload, prop);
          if (desc && (desc.get || desc.set)) {
            throw new ValidationError(`Proof payload property "${prop}" must be a data property, not an accessor`);
          }
        }

        const hasRollback = Object.hasOwn(proofPayload, 'rollback_script');
        const hasDown = Object.hasOwn(proofPayload, 'down_script');

        if (!hasRollback && !hasDown) {
          throw new MissingRollbackProofError('Missing rollback proof for Type E');
        }

        const rollbackVal = hasRollback ? proofPayload.rollback_script : proofPayload.down_script;
        if (rollbackVal === null || rollbackVal === undefined || rollbackVal === '' || (typeof rollbackVal === 'string' && rollbackVal.trim() === '')) {
          throw new MissingRollbackProofError('Missing rollback proof for Type E');
        }

        if (Object.hasOwn(proofPayload, 'rollback_success') && proofPayload.rollback_success !== true) {
          throw new MissingRollbackProofError('Rollback script execution failed');
        }
        if (Object.hasOwn(proofPayload, 'down_script_success') && proofPayload.down_script_success !== true) {
          throw new MissingRollbackProofError('Rollback script execution failed');
        }
        if (Object.hasOwn(proofPayload, 'rollback_execution') && proofPayload.rollback_execution === 'failed') {
          throw new MissingRollbackProofError('Rollback script execution failed');
        }

        // Validate forward_script / up_script format
        const hasForward = Object.hasOwn(proofPayload, 'forward_script');
        const hasUp = Object.hasOwn(proofPayload, 'up_script');
        if (hasForward || hasUp) {
          const forwardVal = hasForward ? proofPayload.forward_script : proofPayload.up_script;
          if (forwardVal === null || forwardVal === undefined || forwardVal === '' || (typeof forwardVal === 'string' && forwardVal.trim() === '')) {
            throw new ValidationError('Forward script is empty or invalid');
          }
        }

        // Validate smoke_tests format
        if (Object.hasOwn(proofPayload, 'smoke_tests')) {
          const smokeVal = proofPayload.smoke_tests;
          if (smokeVal === null || smokeVal === undefined || smokeVal === '' || (typeof smokeVal === 'string' && smokeVal.trim() === '')) {
            throw new ValidationError('Smoke tests are empty or invalid');
          }
        }

        // Validate forward execution success
        if (Object.hasOwn(proofPayload, 'forward_success') && proofPayload.forward_success !== true) {
          throw new ValidationError('Forward script execution failed');
        }
        if (Object.hasOwn(proofPayload, 'up_script_success') && proofPayload.up_script_success !== true) {
          throw new ValidationError('Forward script execution failed');
        }
        if (Object.hasOwn(proofPayload, 'forward_execution') && proofPayload.forward_execution === 'failed') {
          throw new ValidationError('Forward script execution failed');
        }

        // Validate smoke tests success
        if (Object.hasOwn(proofPayload, 'smoke_tests_success') && proofPayload.smoke_tests_success !== true) {
          throw new ValidationError('Smoke test verification failed');
        }
        if (Object.hasOwn(proofPayload, 'smoke_test_verification') && proofPayload.smoke_test_verification === 'failed') {
          throw new ValidationError('Smoke test verification failed');
        }
      }

      return true;
    } catch (err) {
      if (err instanceof ValidationError || err instanceof MissingRollbackProofError) {
        throw err;
      }
      throw new ValidationError(err.message || 'An unexpected error occurred during proof routing');
    }
  }
}

module.exports = {
  ProofRouter
};
