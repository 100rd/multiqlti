const util = require('util');
const { ValidationError, RequiresHumanApproval } = require('./errors');

class SecurityGate {
  static verifyPlan(plan) {
    try {
      if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        throw new ValidationError('Plan is null or invalid');
      }

      if (util.types.isProxy(plan)) {
        throw new ValidationError('Plan cannot be a Proxy');
      }

      if (!Object.prototype.hasOwnProperty.call(plan, 'tasks')) {
        throw new ValidationError('Plan must contain tasks');
      }

      // Check descriptor of plan.tasks to ensure it is not an accessor descriptor
      let currentProto = plan;
      while (currentProto && currentProto !== Object.prototype) {
        const desc = Object.getOwnPropertyDescriptor(currentProto, 'tasks');
        if (desc && (desc.get || desc.set)) {
          throw new ValidationError('plan.tasks must not be an accessor descriptor');
        }
        currentProto = Object.getPrototypeOf(currentProto);
      }

      if (plan.tasks && util.types.isProxy(plan.tasks)) {
        throw new ValidationError('plan.tasks cannot be a Proxy');
      }

      if (!Array.isArray(plan.tasks)) {
        throw new ValidationError('Plan must contain a tasks array');
      }

      // Shallow clone the task list immediately
      const tasks = [...plan.tasks];

      const allowedTypes = ['A', 'B', 'C', 'D', 'E'];

      for (const task of tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task)) {
          throw new ValidationError('Task element is null or invalid');
        }

        if (util.types.isProxy(task)) {
          throw new ValidationError('Task cannot be a Proxy');
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
        for (const prop of ['id', 'type', 'authorizedAs', 'description', 'files', 'paths']) {
          let currentProto = task;
          while (currentProto && currentProto !== Object.prototype) {
            const desc = Object.getOwnPropertyDescriptor(currentProto, prop);
            if (desc && (desc.get || desc.set)) {
              throw new ValidationError(`Task property "${prop}" must be a data property, not an accessor`);
            }
            currentProto = Object.getPrototypeOf(currentProto);
          }
        }

        // Validate files and paths array index property descriptors, proxy, elements, and null bytes / Cyrillic homoglyphs
        for (const prop of ['files', 'paths']) {
          if (Object.hasOwn(task, prop)) {
            const val = task[prop];
            if (Array.isArray(val)) {
              if (util.types.isProxy(val)) {
                throw new ValidationError(`${prop} array cannot be a Proxy`);
              }
              for (let i = 0; i < val.length; i++) {
                let indexProto = val;
                while (indexProto && indexProto !== Object.prototype) {
                  const desc = Object.getOwnPropertyDescriptor(indexProto, i.toString());
                  if (desc && (desc.get || desc.set)) {
                    throw new ValidationError(`Array index property "${i}" of ${prop} must not be an accessor`);
                  }
                  indexProto = Object.getPrototypeOf(indexProto);
                }
              }
              for (const item of val) {
                if (typeof item !== 'string') {
                  throw new ValidationError(`${prop} array elements must be primitive strings`);
                }
                if (item.includes('\u0000')) {
                  if (!item.endsWith('\u0000')) {
                    throw new ValidationError(`${prop} must not contain null bytes in the middle of path`);
                  }
                }
                if (/[\u0430\u0251\u0435\u043e\u0441\u0440\u0445]/.test(item)) {
                  throw new ValidationError(`${prop} must not contain Cyrillic homoglyph characters`);
                }
              }
            } else if (typeof val === 'string') {
              if (val.includes('\u0000')) {
                if (!val.endsWith('\u0000')) {
                  throw new ValidationError(`${prop} must not contain null bytes in the middle of path`);
                }
              }
              if (/[\u0430\u0251\u0435\u043e\u0441\u0440\u0445]/.test(val)) {
                throw new ValidationError(`${prop} must not contain Cyrillic homoglyph characters`);
              }
            } else if (val !== undefined && val !== null) {
              throw new ValidationError(`${prop} must be a string or an array of strings`);
            }
          }
        }

        let touchesSensitive = false;
        const sensitiveSegments = ['migrations', 'deploy', 'package.json'];
        const taskPaths = [];

        if (Object.hasOwn(task, 'files')) {
          const f = task.files;
          if (typeof f === 'string') {
            let item = f;
            if (item.includes('\u0000') && item.endsWith('\u0000')) {
              item = item.slice(0, -1);
            }
            taskPaths.push(item);
          } else if (Array.isArray(f)) {
            for (const origItem of f) {
              let item = origItem;
              if (item.includes('\u0000') && item.endsWith('\u0000')) {
                item = item.slice(0, -1);
              }
              taskPaths.push(item);
            }
          }
        }

        if (Object.hasOwn(task, 'paths')) {
          const p = task.paths;
          if (typeof p === 'string') {
            let item = p;
            if (item.includes('\u0000') && item.endsWith('\u0000')) {
              item = item.slice(0, -1);
            }
            taskPaths.push(item);
          } else if (Array.isArray(p)) {
            for (const origItem of p) {
              let item = origItem;
              if (item.includes('\u0000') && item.endsWith('\u0000')) {
                item = item.slice(0, -1);
              }
              taskPaths.push(item);
            }
          }
        }

        for (const p of taskPaths) {
          const normalized = p.replace(/\\/g, '/');
          const parts = normalized.split('/');
          const stack = [];
          for (const part of parts) {
            if (part === '' || part === '.') {
              continue;
            }
            if (part === '..') {
              if (stack.length > 0 && stack[stack.length - 1] !== '..') {
                stack.pop();
              } else {
                stack.push('..');
              }
            } else {
              stack.push(part);
            }
          }
          const resolvedPath = stack.join('/');
          const segments = resolvedPath.split('/');
          if (segments.some(seg => sensitiveSegments.includes(seg))) {
            touchesSensitive = true;
            break;
          }
        }

        if (touchesSensitive) {
          task.type = 'E';
          task.authorizedAs = 'E';
        }

        // Read back task.type and task.authorizedAs to verify mutation was successful
        if (touchesSensitive) {
          if (task.type !== 'E' || task.authorizedAs !== 'E') {
            throw new ValidationError('Failed to mutate task.type or task.authorizedAs to E');
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
