const fs = require('fs');
const path = require('path');
const PNG = require('pngjs').PNG;
const pixelmatch = require('pixelmatch');

/**
 * Compares actual screenshot and expected baseline PNG.
 * Handles padding for mismatching dimensions, options prototype pollution protection, and diff folder creation.
 * @param {string} actualImagePath - Path to generated PNG
 * @param {string} expectedImagePath - Path to baseline PNG
 * @param {Object} [options] - Comparison options
 * @param {number} [options.threshold=0.1] - pixelmatch color threshold (0 to 1)
 * @param {number} [options.failureThreshold=0.001] - Max ratio of differing pixels allowed
 * @param {string} [options.diffImagePath] - Path to write the diff image if comparison fails
 */
function compareImages(actualImagePath, expectedImagePath, options) {
  const hasOwn = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop);

  let threshold = 0.1;
  if (options && hasOwn(options, 'threshold')) {
    const t = options.threshold;
    if (typeof t !== 'number' || isNaN(t) || t < 0 || t > 1) {
      throw new Error('Invalid threshold: must be a number between 0 and 1');
    }
    threshold = t;
  }

  let failureThreshold = 0.001;
  if (options && hasOwn(options, 'failureThreshold')) {
    const ft = options.failureThreshold;
    if (typeof ft !== 'number' || isNaN(ft) || ft < 0 || ft > 1) {
      throw new Error('Invalid failureThreshold: must be a number between 0 and 1');
    }
    failureThreshold = ft;
  }

  const diffImagePath = (options && hasOwn(options, 'diffImagePath') && typeof options.diffImagePath === 'string')
    ? options.diffImagePath
    : undefined;

  // Reads files - throws ENOENT if they do not exist
  const img1 = PNG.sync.read(fs.readFileSync(actualImagePath));
  const img2 = PNG.sync.read(fs.readFileSync(expectedImagePath));

  const width1 = img1.width;
  const height1 = img1.height;
  const width2 = img2.width;
  const height2 = img2.height;

  const maxWidth = Math.max(width1, width2);
  const maxHeight = Math.max(height1, height2);

  const adjustedImg1 = new PNG({ width: maxWidth, height: maxHeight });
  const adjustedImg2 = new PNG({ width: maxWidth, height: maxHeight });

  for (let y = 0; y < maxHeight; y++) {
    for (let x = 0; x < maxWidth; x++) {
      const inA = x < width1 && y < height1;
      const inB = x < width2 && y < height2;
      const idx = (y * maxWidth + x) * 4;

      if (inA && inB) {
        const idxA = (y * width1 + x) * 4;
        adjustedImg1.data[idx] = img1.data[idxA];
        adjustedImg1.data[idx + 1] = img1.data[idxA + 1];
        adjustedImg1.data[idx + 2] = img1.data[idxA + 2];
        adjustedImg1.data[idx + 3] = img1.data[idxA + 3];

        const idxB = (y * width2 + x) * 4;
        adjustedImg2.data[idx] = img2.data[idxB];
        adjustedImg2.data[idx + 1] = img2.data[idxB + 1];
        adjustedImg2.data[idx + 2] = img2.data[idxB + 2];
        adjustedImg2.data[idx + 3] = img2.data[idxB + 3];
      } else if (!inA && inB) {
        const idxB = (y * width2 + x) * 4;
        const rB = img2.data[idxB];
        const gB = img2.data[idxB + 1];
        const bB = img2.data[idxB + 2];
        const aB = img2.data[idxB + 3];

        adjustedImg1.data[idx] = 255 - rB;
        adjustedImg1.data[idx + 1] = 255 - gB;
        adjustedImg1.data[idx + 2] = 255 - bB;
        adjustedImg1.data[idx + 3] = aB;

        adjustedImg2.data[idx] = rB;
        adjustedImg2.data[idx + 1] = gB;
        adjustedImg2.data[idx + 2] = bB;
        adjustedImg2.data[idx + 3] = aB;
      } else if (inA && !inB) {
        const idxA = (y * width1 + x) * 4;
        const rA = img1.data[idxA];
        const gA = img1.data[idxA + 1];
        const bA = img1.data[idxA + 2];
        const aA = img1.data[idxA + 3];

        adjustedImg1.data[idx] = rA;
        adjustedImg1.data[idx + 1] = gA;
        adjustedImg1.data[idx + 2] = bA;
        adjustedImg1.data[idx + 3] = aA;

        adjustedImg2.data[idx] = 255 - rA;
        adjustedImg2.data[idx + 1] = 255 - gA;
        adjustedImg2.data[idx + 2] = 255 - bA;
        adjustedImg2.data[idx + 3] = aA;
      } else {
        adjustedImg1.data[idx] = 0;
        adjustedImg1.data[idx + 1] = 0;
        adjustedImg1.data[idx + 2] = 0;
        adjustedImg1.data[idx + 3] = 255;

        adjustedImg2.data[idx] = 255;
        adjustedImg2.data[idx + 1] = 255;
        adjustedImg2.data[idx + 2] = 255;
        adjustedImg2.data[idx + 3] = 255;
      }
    }
  }

  const diffPNG = new PNG({ width: maxWidth, height: maxHeight });

  // Compare images
  const mismatchedPixels = pixelmatch(
    adjustedImg1.data,
    adjustedImg2.data,
    diffPNG.data,
    maxWidth,
    maxHeight,
    { threshold }
  );

  const totalPixels = maxWidth * maxHeight;
  const diffRatio = mismatchedPixels / totalPixels;
  const diffPercentage = (diffRatio * 100).toFixed(2) + '%';
  const pass = diffRatio <= failureThreshold;

  // Write diff image if not passing and path is provided
  if (!pass && diffImagePath) {
    const absoluteDiffPath = path.resolve(diffImagePath);
    const canonicalCwd = fs.realpathSync(process.cwd());
    const canonicalTmp = fs.existsSync('/tmp') ? fs.realpathSync('/tmp') : '/tmp';

    const relCwd = path.relative(canonicalCwd, absoluteDiffPath);
    const inCwd = !relCwd.startsWith('..' + path.sep) && relCwd !== '..';

    const relTmp = path.relative(canonicalTmp, absoluteDiffPath);
    const inTmp = !relTmp.startsWith('..' + path.sep) && relTmp !== '..';

    if (!inCwd && !inTmp) {
      throw new Error('Path traversal detected in diffImagePath');
    }

    const diffDir = path.dirname(absoluteDiffPath);
    if (!fs.existsSync(diffDir)) {
      fs.mkdirSync(diffDir, { recursive: true });
    }
    fs.writeFileSync(absoluteDiffPath, PNG.sync.write(diffPNG));
  }

  return {
    pass,
    diffRatio,
    diffPercentage,
    totalPixels,
    mismatchedPixels
  };
}

module.exports = {
  compareImages
};
