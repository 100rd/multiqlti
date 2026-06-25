const { ValidationError } = require('./errors');

class ProofRouter {
  submitCompletedTask(task, proofPayload) {
    try {
      if (!task || typeof task !== 'object' || Array.isArray(task)) {
        throw new ValidationError('Task is null or invalid');
      }

      if (!Object.hasOwn(task, 'id')) {
        throw new ValidationError('Task is missing id field');
      }
      if (!Object.hasOwn(task, 'type')) {
        throw new ValidationError('Task is missing type field');
      }

      // Prevent TOCTOU / getter exploits
      for (const prop of ['id', 'type']) {
        if (Object.hasOwn(task, prop)) {
          const desc = Object.getOwnPropertyDescriptor(task, prop);
          if (desc && (desc.get || desc.set)) {
            throw new ValidationError(`Task property "${prop}" must be a data property, not an accessor`);
          }
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
          throw new ValidationError('Missing rollback proof for Type E');
        }
        if (!Object.hasOwn(proofPayload, 'rollback_script')) {
          throw new ValidationError('Missing rollback proof for Type E');
        }
        const desc = Object.getOwnPropertyDescriptor(proofPayload, 'rollback_script');
        if (desc && (desc.get || desc.set)) {
          throw new ValidationError('Proof payload property "rollback_script" must be a data property, not an accessor');
        }
        const rollbackScript = proofPayload.rollback_script;
        if (rollbackScript === null || rollbackScript === undefined) {
          throw new ValidationError('Missing rollback proof for Type E');
        }
      }

      return true;
    } catch (err) {
      if (err instanceof ValidationError) {
        throw err;
      }
      throw new ValidationError(err.message || 'An unexpected error occurred during proof routing');
    }
  }
}

module.exports = {
  ProofRouter
};
