const { ValidationError, RequiresHumanApproval } = require('./errors');

class SecurityGate {
  static verifyPlan(plan) {
    try {
      if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        throw new ValidationError('Plan is null or invalid');
      }

      if (!Object.prototype.hasOwnProperty.call(plan, 'tasks')) {
        throw new ValidationError('Plan must contain tasks');
      }

      const tasks = plan.tasks;
      if (!Array.isArray(tasks)) {
        throw new ValidationError('Plan must contain a tasks array');
      }

      const allowedTypes = ['A', 'B', 'C', 'D', 'E'];

      for (const task of tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task)) {
          throw new ValidationError('Task element is null or invalid');
        }

        // Prevent prototype pollution
        if (!Object.hasOwn(task, 'id')) {
          throw new ValidationError('Task is missing id field');
        }
        if (!Object.hasOwn(task, 'type')) {
          throw new ValidationError('Task is missing type field');
        }
        if (!Object.hasOwn(task, 'authorizedAs')) {
          throw new ValidationError('Task is missing authorizedAs field');
        }

        // Prevent TOCTOU / getter exploits
        for (const prop of ['id', 'type', 'authorizedAs', 'description']) {
          if (Object.hasOwn(task, prop)) {
            const desc = Object.getOwnPropertyDescriptor(task, prop);
            if (desc && (desc.get || desc.set)) {
              throw new ValidationError(`Task property "${prop}" must be a data property, not an accessor`);
            }
          }
        }

        const taskId = task.id;
        const taskType = task.type;
        const taskAuthorizedAs = task.authorizedAs;

        if (typeof taskId !== 'string' || taskId.trim() === '') {
          throw new ValidationError('Task id must be a non-empty string');
        }

        if (typeof taskType !== 'string' || !allowedTypes.includes(taskType)) {
          throw new ValidationError(`Task has invalid/unsupported type enum "${taskType}"`);
        }

        if (typeof taskAuthorizedAs !== 'string' || !allowedTypes.includes(taskAuthorizedAs)) {
          throw new ValidationError('Task is missing or has invalid authorizedAs field');
        }

        let desc = '';
        if (Object.hasOwn(task, 'description')) {
          const rawDesc = task.description;
          if (rawDesc !== null && rawDesc !== undefined) {
            if (typeof rawDesc !== 'string') {
              throw new ValidationError('Task description must be a string');
            }
            desc = rawDesc;
          }
        }

        // Normalize description to counter unicode homoglyphs and formatting bypasses
        const normalizedDesc = desc
          .normalize('NFKD')
          .replace(/[\u0430\u0251]/g, 'a')
          .replace(/\u0435/g, 'e')
          .replace(/\u043e/g, 'o')
          .replace(/\u0441/g, 'c')
          .replace(/\u0440/g, 'p')
          .replace(/\u0445/g, 'x')
          .replace(/\s+/g, '') // collapse all whitespaces including newlines
          .toLowerCase();

        const isDbMigration = taskType === 'E' || normalizedDesc.includes('databasemigration');

        if (isDbMigration && taskAuthorizedAs === 'A') {
          throw new ValidationError('Database migration tasks cannot be authorized as Type A');
        }

        if (taskType === 'D') {
          throw new RequiresHumanApproval('Task requires human approval');
        }
      }

      return true;
    } catch (err) {
      if (err instanceof ValidationError || err instanceof RequiresHumanApproval) {
        throw err;
      }
      throw new ValidationError(err.message || 'An unexpected error occurred during verification');
    }
  }
}

module.exports = {
  SecurityGate
};
