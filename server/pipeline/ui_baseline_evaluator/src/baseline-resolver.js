const path = require('path');
const fs = require('fs');
const { BaselineMissingError } = require('./errors');

/**
 * Resolves a component/task path to its corresponding baseline image.
 * Supports a path traversal guard and flat fallback.
 * @param {string} componentPath - e.g. "Button.tsx" or "common/Header.jsx"
 * @param {string} baselinesDir - Path to the baselines directory
 * @returns {string} Absolute path to resolved baseline image
 */
function resolveBaseline(componentPath, baselinesDir) {
  if (!componentPath || typeof componentPath !== 'string') {
    throw new Error('Component path must be a non-empty string');
  }
  if (!baselinesDir || typeof baselinesDir !== 'string') {
    throw new Error('Baselines directory must be a non-empty string');
  }

  const absBaselinesDir = path.resolve(baselinesDir);

  const parsed = path.parse(componentPath);

  const checkTraversal = (resolvedPath) => {
    const canonicalBaselinesDir = fs.existsSync(absBaselinesDir) ? fs.realpathSync(absBaselinesDir) : absBaselinesDir;
    let canonicalResolvedPath;
    if (fs.existsSync(resolvedPath)) {
      canonicalResolvedPath = fs.realpathSync(resolvedPath);
    } else {
      let current = resolvedPath;
      let parent = path.dirname(current);
      while (parent && parent !== current && !fs.existsSync(parent)) {
        current = parent;
        parent = path.dirname(current);
      }
      if (fs.existsSync(parent)) {
        const relativePart = path.relative(parent, resolvedPath);
        canonicalResolvedPath = path.resolve(fs.realpathSync(parent), relativePart);
      } else {
        canonicalResolvedPath = path.resolve(resolvedPath);
      }
    }

    const relative = path.relative(canonicalBaselinesDir, canonicalResolvedPath);
    const isSafe = !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
    if (!isSafe) {
      throw new Error('Path traversal detected');
    }
  };

  // 1. Nested resolution
  const relativePngPath = path.join(parsed.dir, `${parsed.name}.png`);
  const resolvedPath = path.resolve(absBaselinesDir, relativePngPath);

  // Path traversal guard
  checkTraversal(resolvedPath);

  // Check if nested baseline exists
  if (fs.existsSync(resolvedPath)) {
    return resolvedPath;
  }

  // 2. Flat fallback (only base filename)
  const flatPngPath = `${parsed.name}.png`;
  const flatResolvedPath = path.resolve(absBaselinesDir, flatPngPath);

  // Path traversal guard for flat path (precautionary)
  checkTraversal(flatResolvedPath);

  if (fs.existsSync(flatResolvedPath)) {
    return flatResolvedPath;
  }

  // If neither exists, throw BaselineMissingError
  throw new BaselineMissingError(`Baseline image missing for component: ${componentPath} (resolved: ${resolvedPath})`);
}

module.exports = {
  resolveBaseline
};
