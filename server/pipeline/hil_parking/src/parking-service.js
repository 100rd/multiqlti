const fs = require('fs').promises;
const path = require('path');
const { InvalidHILRequestError, CircuitBreakerError } = require('./errors');

// Global maps to ensure in-memory mutex safety per file path across instances
const fileLocks = new Map();

class FileLock {
  constructor() {
    this.promise = Promise.resolve();
  }
  async acquire() {
    let resolve;
    const nextPromise = new Promise(r => resolve = r);
    const release = () => resolve();
    const currentPromise = this.promise;
    this.promise = nextPromise;
    await currentPromise;
    return release;
  }
}

function getLock(storePath) {
  const absPath = path.resolve(storePath);
  if (!fileLocks.has(absPath)) {
    fileLocks.set(absPath, new FileLock());
  }
  return fileLocks.get(absPath);
}

async function runWithLock(storePath, fn) {
  const lock = getLock(storePath);
  const release = await lock.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

// Homoglyphs to Latin mappings
const HOMOGLYPH_MAP = {
  '\u0430': 'a', '\u03b1': 'a', // Cyrillic a, Greek alpha
  '\u0435': 'e', '\u03b5': 'e', // Cyrillic e, Greek epsilon
  '\u043e': 'o', '\u03bf': 'o', // Cyrillic o, Greek omicron
  '\u0440': 'p', '\u03c1': 'p', // Cyrillic p, Greek rho
  '\u0441': 'c', '\u03f2': 'c', // Cyrillic c, Greek lunate sigma
  '\u0443': 'y', '\u03c5': 'y', // Cyrillic u/y, Greek upsilon
  '\u0445': 'x', '\u03c7': 'x', // Cyrillic x, Greek chi
  '\u0456': 'i', '\u03b9': 'i', // Cyrillic i, Greek iota
  '\u043c': 'm', '\u041c': 'm', // Cyrillic м, Cyrillic М
  '\u0131': 'i', '\u0130': 'i', // Small dotless i, Capital dotless I
  '\u0455': 's',
  '\u0458': 'j',
  '\u04bb': 'h',
  '\u0501': 'd',
  '\u051d': 'w',
  // Fullwidth lowercase
  '\uff41': 'a', '\uff42': 'b', '\uff43': 'c', '\uff44': 'd', '\uff45': 'e',
  '\uff46': 'f', '\uff47': 'g', '\uff48': 'h', '\uff49': 'i', '\uff4a': 'j',
  '\uff4b': 'k', '\uff4c': 'l', '\uff4d': 'm', '\uff4e': 'n', '\uff4f': 'o',
  '\uff50': 'p', '\uff51': 'q', '\uff52': 'r', '\uff53': 's', '\uff54': 't',
  '\uff55': 'u', '\uff56': 'v', '\uff57': 'w', '\uff58': 'x', '\uff59': 'y',
  '\uff5a': 'z'
};

function hasPrototypePollution(obj, visited = new WeakSet()) {
  if (obj === null || typeof obj !== 'object') return false;
  if (visited.has(obj)) return false;
  visited.add(obj);

  const proto = Object.getPrototypeOf(obj);
  if (Array.isArray(obj)) {
    if (proto !== Array.prototype) {
      return true;
    }
  } else {
    if (proto !== Object.prototype && proto !== null) {
      return true;
    }
  }

  const keys = Object.getOwnPropertyNames(obj);
  for (const key of keys) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return true;
    }
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc && (desc.get || desc.set)) {
      continue;
    }
    try {
      const val = obj[key];
      if (val && typeof val === 'object') {
        if (hasPrototypePollution(val, visited)) return true;
      }
    } catch (err) {
      // Re-throw property getter errors so DoS attempts fail visibly
      throw err;
    }
  }
  return false;
}

class HILParkingService {
  constructor(options = {}) {
    this.storePath = options.storePath || 'parking_store.json';
    this.limitPercent = options.limitPercent !== undefined ? options.limitPercent : 15;
  }

  async _readStore() {
    try {
      const data = await fs.readFile(this.storePath, 'utf8');
      if (!data.trim()) return [];
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async _writeStore(store) {
    const tempPath = `${this.storePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2), 'utf8');
    await fs.rename(tempPath, this.storePath);
  }

  _calculateStats(store) {
    const activeStatuses = ['AWAITING_HUMAN', 'IN_PROGRESS', 'RUNNING', 'PENDING'];
    const activeTasks = store.filter(t => activeStatuses.includes(t.status));
    const awaitingHumanTasks = store.filter(t => t.status === 'AWAITING_HUMAN');

    const totalActive = activeTasks.length;
    const awaitingHuman = awaitingHumanTasks.length;
    const ratioPercent = totalActive > 0 ? (awaitingHuman / totalActive) * 100 : 0;

    return { totalActive, awaitingHuman, ratioPercent };
  }

  _normalizeDescription(desc) {
    if (!desc || typeof desc !== 'string') return '';
    const decomposed = desc.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    let replaced = '';
    for (const char of decomposed) {
      replaced += HOMOGLYPH_MAP[char] || char;
    }
    return replaced.replace(/\s+/g, '');
  }

  _validateAuthorizationGate(task) {
    if (!task.description || typeof task.description !== 'string' || task.description.trim() === '') {
      throw new InvalidHILRequestError('Description is empty or missing');
    }
    const normalized = this._normalizeDescription(task.description);
    
    const criticalKeywords = [
      'productionpersistentstate',
      'databasemigration',
      'modifydatabase',
      'deleteuserdata',
      'securitypolicy',
      'productiondeployment',
      'schemachange',
      'paymentgateway'
    ];

    const hasCritical = criticalKeywords.some(keyword => normalized.includes(keyword));

    if (hasCritical) {
      return true;
    }

    throw new InvalidHILRequestError('Task description does not meet Type D critical criteria');
  }

  _validateTask(task) {
    if (!task || typeof task !== 'object') {
      throw new Error('Task must be a valid object');
    }
    if (hasPrototypePollution(task)) {
      throw new Error('Prototype pollution attempt detected');
    }
    if (!task.id || typeof task.id !== 'string') {
      throw new Error('Task must contain a valid string ID');
    }
    if (!task.type || typeof task.type !== 'string') {
      throw new Error('Task must contain a valid string type');
    }
    const validTypes = ['A', 'B', 'C', 'D', 'E'];
    if (!validTypes.includes(task.type)) {
      throw new Error(`Unsupported task type: ${task.type}`);
    }
  }

  async getQueueStats() {
    return await runWithLock(this.storePath, async () => {
      const store = await this._readStore();
      return this._calculateStats(store);
    });
  }

  async submitTask(task, executePayloadFn) {
    if (!task || typeof task !== 'object') {
      throw new Error('Task must be a valid object');
    }

    // Capture snapshot of properties at the very start to freeze getter evaluations
    const taskSnapshot = {
      id: task.id,
      type: task.type,
      description: task.description,
      payload: task.payload
    };

    let isTypeD = false;

    // Run the breaker check, validation, and Type D parking in a single transactional lock
    await runWithLock(this.storePath, async () => {
      const store = await this._readStore();
      const stats = this._calculateStats(store);

      // 1. Check Circuit Breaker first (precedence)
      if (stats.ratioPercent > this.limitPercent) {
        throw new CircuitBreakerError(`Circuit breaker tripped: awaiting ratio is ${stats.ratioPercent.toFixed(2)}%`);
      }

      // 2. Validate basic task structure and guard against prototype pollution on snapshot
      this._validateTask(taskSnapshot);
      // Validate original task to ensure prototype pollution on the top-level task object is detected
      if (hasPrototypePollution(task)) {
        throw new Error('Prototype pollution attempt detected');
      }

      if (taskSnapshot.type === 'D') {
        isTypeD = true;
        
        // 3. Authorization Gate validation
        this._validateAuthorizationGate(taskSnapshot);

        if (store.some(t => t.id === taskSnapshot.id)) {
          throw new Error(`Task with ID ${taskSnapshot.id} already exists`);
        }

        const parkedTask = {
          id: taskSnapshot.id,
          type: taskSnapshot.type,
          description: taskSnapshot.description,
          status: 'AWAITING_HUMAN',
          payload: taskSnapshot.payload
        };
        store.push(parkedTask);
        await this._writeStore(store);
      }
    });

    if (isTypeD) {
      return { status: 'AWAITING_HUMAN', parked: true };
    } else {
      // Non-Type D task: execute payload directly outside the lock
      if (typeof executePayloadFn !== 'function') {
        throw new Error('executePayloadFn is required and must be a function');
      }
      try {
        const result = await executePayloadFn();
        return { status: 'COMPLETED', parked: false, result };
      } catch (err) {
        return { status: 'FAILED', parked: false };
      }
    }
  }

  async approveTask(taskId, executePayloadFn) {
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('Valid Task ID is required');
    }
    if (typeof executePayloadFn !== 'function') {
      throw new Error('executePayloadFn is required and must be a function');
    }

    // Step 1: Transition status to APPROVED under the lock
    await runWithLock(this.storePath, async () => {
      const store = await this._readStore();
      const task = store.find(t => t.id === taskId);
      if (!task) {
        throw new Error(`Task with ID ${taskId} not found`);
      }
      if (task.status !== 'AWAITING_HUMAN') {
        throw new Error(`Task with status ${task.status} cannot be approved`);
      }
      task.status = 'APPROVED';
      await this._writeStore(store);
    });

    // Step 2: Execute payload function outside the lock
    let result;
    try {
      result = await executePayloadFn();
    } catch (err) {
      // Step 3a: Transition to FAILED under the lock on error
      await runWithLock(this.storePath, async () => {
        const store = await this._readStore();
        const task = store.find(t => t.id === taskId);
        if (task) {
          task.status = 'FAILED';
          await this._writeStore(store);
        }
      });
      throw err;
    }

    // Step 3b: Transition to COMPLETED under the lock on success
    await runWithLock(this.storePath, async () => {
      const store = await this._readStore();
      const task = store.find(t => t.id === taskId);
      if (task) {
        task.status = 'COMPLETED';
        await this._writeStore(store);
      }
    });

    return result;
  }

  async rejectTask(taskId) {
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('Valid Task ID is required');
    }

    return await runWithLock(this.storePath, async () => {
      const store = await this._readStore();
      const task = store.find(t => t.id === taskId);
      if (!task) {
        throw new Error(`Task with ID ${taskId} not found`);
      }
      if (task.status !== 'AWAITING_HUMAN') {
        throw new Error(`Task with status ${task.status} cannot be rejected`);
      }

      task.status = 'REJECTED';
      await this._writeStore(store);
      return task;
    });
  }

  async addTaskToQueue(task, status) {
    if (!task || typeof task !== 'object') {
      throw new Error('Task must be a valid object');
    }
    this._checkPrototypePollution(task);
    if (!task.id || typeof task.id !== 'string') {
      throw new Error('Task must contain a valid string ID');
    }
    if (!task.type || typeof task.type !== 'string') {
      throw new Error('Task must contain a valid string type');
    }
    if (!status || typeof status !== 'string') {
      throw new Error('Valid status is required');
    }

    return await runWithLock(this.storePath, async () => {
      const store = await this._readStore();
      const idx = store.findIndex(t => t.id === task.id);
      const newTask = {
        id: task.id,
        type: task.type,
        description: task.description,
        status: status,
        payload: task.payload
      };
      if (idx > -1) {
        store[idx] = newTask;
      } else {
        store.push(newTask);
      }
      await this._writeStore(store);
      return newTask;
    });
  }

  _checkPrototypePollution(obj) {
    if (hasPrototypePollution(obj)) {
      throw new Error('Prototype pollution attempt detected');
    }
  }

  async clearQueue() {
    return await runWithLock(this.storePath, async () => {
      try {
        await fs.unlink(this.storePath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }
    });
  }
}

module.exports = {
  HILParkingService
};
