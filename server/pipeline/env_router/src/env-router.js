const util = require('util');
const { ValidationError, RestrictedEnvironmentError } = require('./errors');

// Homoglyphs to Latin mappings
const HOMOGLYPH_MAP = {
  '\u0430': 'a', '\u0410': 'a', '\u03b1': 'a', '\u0391': 'a', // Cyrillic a/A, Greek alpha
  '\u0435': 'e', '\u0415': 'e', '\u03b5': 'e', '\u0395': 'e', // Cyrillic e/E, Greek epsilon
  '\u043e': 'o', '\u041e': 'o', '\u03bf': 'o', '\u039f': 'o', // Cyrillic o/O, Greek omicron
  '\u0440': 'p', '\u0420': 'p', '\u03c1': 'p', '\u03a1': 'p', // Cyrillic p/P, Greek rho
  '\u0441': 'c', '\u0421': 'c', '\u03f2': 'c', // Cyrillic c/C, Greek lunate sigma
  '\u0443': 'y', '\u0423': 'y', '\u03c5': 'y', '\u03a5': 'y', // Cyrillic u/U, Greek upsilon
  '\u0445': 'x', '\u0425': 'x', '\u03c7': 'x', '\u03a7': 'x', // Cyrillic x/X, Greek chi
  '\u0456': 'i', '\u0406': 'i', '\u03b9': 'i', '\u0399': 'i', // Cyrillic i/I, Greek iota
  '\u043c': 'm', '\u041c': 'm', // Cyrillic м/М
  '\u0131': 'i', '\u0130': 'i', // Small/Capital dotless i
  '\u0455': 's', '\u0405': 's',
  '\u0458': 'j', '\u0408': 'j',
  '\u04bb': 'h', '\u04ba': 'h',
  '\u0501': 'd', '\u0500': 'd',
  '\u051d': 'w', '\u051c': 'w',
  // Fullwidth lowercase
  '\uff41': 'a', '\uff42': 'b', '\uff43': 'c', '\uff44': 'd', '\uff45': 'e',
  '\uff46': 'f', '\uff47': 'g', '\uff48': 'h', '\uff49': 'i', '\uff4a': 'j',
  '\uff4b': 'k', '\uff4c': 'l', '\uff4d': 'm', '\uff4e': 'n', '\uff4f': 'o',
  '\uff50': 'p', '\uff51': 'q', '\uff52': 'r', '\uff53': 's', '\uff54': 't',
  '\uff55': 'u', '\uff56': 'v', '\uff57': 'w', '\uff58': 'x', '\uff59': 'y',
  '\uff5a': 'z',
  // Fullwidth uppercase
  '\uff21': 'a', '\uff22': 'b', '\uff23': 'c', '\uff24': 'd', '\uff25': 'e',
  '\uff26': 'f', '\uff27': 'g', '\uff28': 'h', '\uff29': 'i', '\uff2a': 'j',
  '\uff2b': 'k', '\uff2c': 'l', '\uff2d': 'm', '\uff2e': 'n', '\uff2f': 'o',
  '\uff30': 'p', '\uff31': 'q', '\uff32': 'r', '\uff33': 's', '\uff34': 't',
  '\uff35': 'u', '\uff36': 'v', '\uff37': 'w', '\uff38': 'x', '\uff39': 'y',
  '\uff3a': 'z'
};

const CYRILLIC_HOMOGLYPH_REGEX = /[\u0430\u0410\u0435\u0415\u043e\u041e\u0440\u0420\u0441\u0421\u0443\u0423\u0445\u0425\u0456\u0406\u043c\u041c\u0455\u0405\u0458\u0408\u04bb\u04ba\u0501\u0500\u051d\u051c]/;

function isProxy(val) {
  if (val && (typeof val === 'object' || typeof val === 'function')) {
    return util.types.isProxy(val);
  }
  return false;
}

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
      throw err;
    }
  }
  return false;
}

class EnvironmentRouter {
  /**
   * Route a task based on execution context and environment rules
   * @param {Object} task
   * @param {Object} executionContext
   * @returns {boolean}
   */
  route(task, executionContext) {
    // 1. Guard against null/invalid parameters
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new ValidationError('Task must be a valid object');
    }
    if (!executionContext || typeof executionContext !== 'object' || Array.isArray(executionContext)) {
      throw new ValidationError('Execution context must be a valid object');
    }

    // 2. Prevent ES6 Proxy exploits (TOCTOU defense)
    if (isProxy(task)) {
      throw new ValidationError('Task object must not be a Proxy');
    }
    if (isProxy(executionContext)) {
      throw new ValidationError('Execution context must not be a Proxy');
    }

    // 3. Prevent TOCTOU / getter exploits on critical fields by checking descriptors
    const criticalTaskProps = ['id', 'type', 'authorizedAs', 'loadScaleTesting'];
    for (const prop of criticalTaskProps) {
      let currentProto = task;
      while (currentProto && currentProto !== Object.prototype) {
        if (Object.prototype.hasOwnProperty.call(currentProto, prop)) {
          const desc = Object.getOwnPropertyDescriptor(currentProto, prop);
          if (desc && (desc.get || desc.set)) {
            throw new ValidationError(`Task property "${prop}" must be a data descriptor, not an accessor`);
          }
        }
        currentProto = Object.getPrototypeOf(currentProto);
      }
    }

    const criticalContextProps = ['env', 'query'];
    for (const prop of criticalContextProps) {
      let currentProto = executionContext;
      while (currentProto && currentProto !== Object.prototype) {
        if (Object.prototype.hasOwnProperty.call(currentProto, prop)) {
          const desc = Object.getOwnPropertyDescriptor(currentProto, prop);
          if (desc && (desc.get || desc.set)) {
            throw new ValidationError(`Execution context property "${prop}" must be a data descriptor, not an accessor`);
          }
        }
        currentProto = Object.getPrototypeOf(currentProto);
      }
    }

    // Prevent global Object.prototype pollution checking
    for (const prop of [...criticalTaskProps, ...criticalContextProps]) {
      const desc = Object.getOwnPropertyDescriptor(Object.prototype, prop);
      if (desc) {
        throw new ValidationError(`Prototype pollution detected: Object.prototype has property "${prop}"`);
      }
    }

    // Prototype pollution checks on task and executionContext
    if (hasPrototypePollution(task)) {
      throw new ValidationError('Prototype pollution detected in task');
    }
    if (hasPrototypePollution(executionContext)) {
      throw new ValidationError('Prototype pollution detected in execution context');
    }

    // 4. Validate and copy task fields
    if (!Object.prototype.hasOwnProperty.call(task, 'id') || typeof task.id !== 'string' || task.id.trim() === '') {
      throw new ValidationError('Task must have a non-empty string "id" property');
    }
    if (!Object.prototype.hasOwnProperty.call(task, 'type') || typeof task.type !== 'string') {
      throw new ValidationError('Task must have a string "type" property');
    }

    const taskId = task.id;
    const taskType = task.type;
    const loadScaleTesting = !!task.loadScaleTesting;

    // 5. Validate environment
    if (!Object.prototype.hasOwnProperty.call(executionContext, 'env') || typeof executionContext.env !== 'string') {
      throw new ValidationError('Execution context must contain a string "env" property');
    }
    const env = executionContext.env;
    if (env.includes('\u0000')) {
      throw new ValidationError('Environment contains null bytes');
    }
    if (CYRILLIC_HOMOGLYPH_REGEX.test(env)) {
      throw new ValidationError('Environment contains forbidden characters or Cyrillic homoglyphs');
    }

    const envNormalized = env.trim().toLowerCase();
    const allowedEnvs = ['ephemeral', 'persistent', 'prod'];
    if (!allowedEnvs.includes(envNormalized)) {
      throw new ValidationError(`Invalid environment target: "${env}"`);
    }

    // 6. Validate query payload
    if (!Object.prototype.hasOwnProperty.call(executionContext, 'query') || typeof executionContext.query !== 'string') {
      throw new ValidationError('Execution context must contain a string "query" property');
    }
    const query = executionContext.query;
    if (query.trim() === '') {
      throw new ValidationError('Query statement must not be empty');
    }
    if (query.includes('\u0000')) {
      throw new ValidationError('Query contains null bytes');
    }
    if (CYRILLIC_HOMOGLYPH_REGEX.test(query)) {
      throw new ValidationError('Query contains forbidden characters or Cyrillic homoglyphs');
    }

    // 7. Parse SQL query statement for destructive actions / mutations
    const isDestructiveOrMutation = this._isDestructiveOrMutationQuery(query);

    // 8. Evaluate Environment Matrix Policies
    if (envNormalized === 'ephemeral') {
      return true;
    }

    if (envNormalized === 'persistent') {
      if (!loadScaleTesting) {
        throw new ValidationError('Persistent environment access requires task to be flagged for load/scale testing');
      }
      if (isDestructiveOrMutation && taskType !== 'D') {
        throw new RestrictedEnvironmentError(
          `Destructive actions/mutations on Persistent environments are restricted and require human approval (Type D)`
        );
      }
      return true;
    }

    if (envNormalized === 'prod') {
      if (isDestructiveOrMutation && taskType !== 'D') {
        throw new RestrictedEnvironmentError(
          `Destructive actions/mutations on Production environments are restricted and require human approval (Type D)`
        );
      }
      return true;
    }

    throw new ValidationError('Unhandled environment configuration');
  }

  /**
   * Route execution based on task, env, and query string
   * @param {Object} task
   * @param {string} env
   * @param {string} query
   * @returns {boolean}
   */
  routeExecution(task, env, query) {
    if (isProxy(query)) {
      throw new ValidationError('Query cannot be a Proxy');
    }
    return this.route(task, { env, query });
  }

  /**
   * Normalizes SQL queries and identifies destructive/mutating operations
   * @private
   */
  _isDestructiveOrMutationQuery(query) {
    // Decompose using NFKD
    let normalized = query.normalize('NFKD');
    
    // Map homoglyphs using HOMOGLYPH_MAP
    let replaced = '';
    for (const char of normalized) {
      replaced += HOMOGLYPH_MAP[char] || char;
    }
    
    // Strip comments
    let cleaned = replaced.replace(/--.*$/gm, '');
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
    
    // Strip string literals
    cleaned = cleaned.replace(/'(\\.|[^'\\])*'/g, '');
    cleaned = cleaned.replace(/"(\\.|[^"\\])*"/g, '');
    cleaned = cleaned.replace(/`(\\.|[^`\\])*`/g, '');
    
    // Match forbidden destructive/mutation keywords at word boundaries
    const forbiddenKeywords = [
      'drop', 'alter', 'truncate', 'delete', 'update', 'insert',
      'create', 'rename', 'replace', 'grant', 'revoke'
    ];
    
    const keywordRegex = new RegExp(`\\b(${forbiddenKeywords.join('|')})\\b`, 'i');
    return keywordRegex.test(cleaned);
  }
}

module.exports = {
  EnvironmentRouter
};
