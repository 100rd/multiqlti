const fs = require('fs');
const path = require('path');
const { resolveBaseline } = require('../../src/baseline-resolver');
const { compareImages } = require('../../src/pixel-comparator');
const { createMockPNG } = require('../helpers');

describe('SPEC-03 UI Baselines Evaluator - Adversarial & Robustness Tests', () => {
  const tmpDir = path.resolve(__dirname, '../../tmp-adversarial-fixtures');
  const baselinesDir = path.join(tmpDir, 'baselines');
  const actualsDir = path.join(tmpDir, 'actuals');

  beforeAll(() => {
    fs.mkdirSync(baselinesDir, { recursive: true });
    fs.mkdirSync(actualsDir, { recursive: true });

    // Standard baseline Button for prototype pollution test
    createMockPNG(path.join(baselinesDir, 'Button.png'), 100, 100, { r: 255, g: 255, b: 255, a: 255 });
    createMockPNG(path.join(actualsDir, 'Button.png'), 100, 100, { r: 255, g: 255, b: 255, a: 255 });

    // Different size images
    // img1: 100x120 white
    createMockPNG(path.join(actualsDir, 'diff_size_1.png'), 100, 120, { r: 255, g: 255, b: 255, a: 255 });
    // img2: 120x100 white
    createMockPNG(path.join(baselinesDir, 'diff_size_2.png'), 120, 100, { r: 255, g: 255, b: 255, a: 255 });

    // Corrupted file
    fs.writeFileSync(path.join(actualsDir, 'corrupt.png'), 'Not a PNG file content at all!');
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Adversarial: mismatched image dimensions (padding check)', () => {
    const path1 = path.join(actualsDir, 'diff_size_1.png');
    const path2 = path.join(baselinesDir, 'diff_size_2.png');

    // Should pad both to 120x120 bounding box
    const result = compareImages(path1, path2);
    expect(result.pass).toBe(false);
    expect(result.totalPixels).toBe(120 * 120); // 14400
    // Mismatched pixels should count the non-overlapping padded areas
    expect(result.mismatchedPixels).toBeGreaterThan(0);
  });

  test('Adversarial: corrupted PNG file throws error', () => {
    const corruptPath = path.join(actualsDir, 'corrupt.png');
    const normalPath = path.join(baselinesDir, 'Button.png');

    expect(() => {
      compareImages(corruptPath, normalPath);
    }).toThrow();
  });

  test('Adversarial: missing files propagate ENOENT filesystem errors', () => {
    const missingPath = path.join(actualsDir, 'does-not-exist.png');
    const normalPath = path.join(baselinesDir, 'Button.png');

    expect(() => {
      compareImages(missingPath, normalPath);
    }).toThrow(/ENOENT/);
  });

  test('Adversarial: path traversal guard rejects outer paths', () => {
    // Attempting to break out of baselinesDir using relative dot segments
    const maliciousPath = '../../package.json';
    expect(() => {
      resolveBaseline(maliciousPath, baselinesDir);
    }).toThrow('Path traversal detected');
  });

  test('Adversarial: options prototype pollution shield', () => {
    const baselinePath = path.join(baselinesDir, 'Button.png');
    const actualPath = path.join(actualsDir, 'Button.png');

    // Pollute Object.prototype
    Object.prototype.threshold = 'malicious_polluted_value';
    Object.prototype.failureThreshold = 'malicious_polluted_value';
    Object.prototype.diffImagePath = '/tmp/polluted_diff_path.png';

    try {
      // With type/hasOwnProperty checking, compareImages should ignore these polluted prototype values
      // and use standard default values (0.1, 0.001) successfully.
      const result = compareImages(actualPath, baselinePath, {});
      expect(result.pass).toBe(true);
      expect(result.diffRatio).toBe(0);
    } finally {
      // Clean up polluted prototype
      delete Object.prototype.threshold;
      delete Object.prototype.failureThreshold;
      delete Object.prototype.diffImagePath;
    }
  });
});
