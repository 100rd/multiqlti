const fs = require('fs');
const path = require('path');
const { resolveBaseline } = require('../../src/baseline-resolver');
const { compareImages } = require('../../src/pixel-comparator');
const { BaselineMissingError } = require('../../src/errors');
const { createMockPNG } = require('../helpers');

describe('SPEC-03 UI Baselines Evaluator - Extra Adversarial & Robustness Checks', () => {
  const tmpDir = path.resolve(__dirname, '../../tmp-adversarial-extra-fixtures');
  const baselinesDir = path.join(tmpDir, 'baselines');
  const actualsDir = path.join(tmpDir, 'actuals');

  beforeAll(() => {
    fs.mkdirSync(baselinesDir, { recursive: true });
    fs.mkdirSync(actualsDir, { recursive: true });

    // Create 100x100 white PNG
    createMockPNG(path.join(baselinesDir, '100x100_white.png'), 100, 100, { r: 255, g: 255, b: 255, a: 255 });
    createMockPNG(path.join(actualsDir, '100x100_white.png'), 100, 100, { r: 255, g: 255, b: 255, a: 255 });

    // Create 1x1 white PNG
    createMockPNG(path.join(baselinesDir, '1x1_white.png'), 1, 1, { r: 255, g: 255, b: 255, a: 255 });
    createMockPNG(path.join(actualsDir, '1x1_white.png'), 1, 1, { r: 255, g: 255, b: 255, a: 255 });

    // Create empty file (0 bytes)
    fs.writeFileSync(path.join(actualsDir, 'empty.png'), '');
    fs.writeFileSync(path.join(baselinesDir, 'empty.png'), '');
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 1. Empty File Checks
  test('Adversarial: Empty actual file throws error', () => {
    const emptyActual = path.join(actualsDir, 'empty.png');
    const normalExpected = path.join(baselinesDir, '100x100_white.png');
    expect(() => {
      compareImages(emptyActual, normalExpected);
    }).toThrow();
  });

  test('Adversarial: Empty expected file throws error', () => {
    const normalActual = path.join(actualsDir, '100x100_white.png');
    const emptyExpected = path.join(baselinesDir, 'empty.png');
    expect(() => {
      compareImages(normalActual, emptyExpected);
    }).toThrow();
  });

  test('Adversarial: Both files empty throws error', () => {
    const emptyActual = path.join(actualsDir, 'empty.png');
    const emptyExpected = path.join(baselinesDir, 'empty.png');
    expect(() => {
      compareImages(emptyActual, emptyExpected);
    }).toThrow();
  });

  // 2. Dimension Mismatch Variations
  test('Adversarial: 1x1 vs 100x100 dimension mismatch details', () => {
    const actual1x1 = path.join(actualsDir, '1x1_white.png');
    const expected100x100 = path.join(baselinesDir, '100x100_white.png');

    const result = compareImages(actual1x1, expected100x100);
    expect(result.pass).toBe(false);
    expect(result.totalPixels).toBe(10000);
    // AdjustedImg1 (1x1 padded to 100x100): pixel (0,0) is white, other 9999 are opaque black
    // AdjustedImg2 (100x100): all 10000 are white
    // Mismatched pixels should be exactly 9999
    expect(result.mismatchedPixels).toBe(9999);
  });

  test('Adversarial: 100x100 vs 1x1 dimension mismatch details', () => {
    const actual100x100 = path.join(actualsDir, '100x100_white.png');
    const expected1x1 = path.join(baselinesDir, '1x1_white.png');

    const result = compareImages(actual100x100, expected1x1);
    expect(result.pass).toBe(false);
    expect(result.totalPixels).toBe(10000);
    expect(result.mismatchedPixels).toBe(9999);
  });

  // 3. Invalid Options Parameters (NaN, Negative, Bounds, etc.)
  test('Adversarial: options.threshold as NaN throws error', () => {
    const actual = path.join(actualsDir, '100x100_white.png');
    const expected = path.join(baselinesDir, '100x100_white.png');

    expect(() => {
      compareImages(actual, expected, { threshold: NaN });
    }).toThrow('Invalid threshold');
  });

  test('Adversarial: options.failureThreshold as NaN throws error', () => {
    const actual = path.join(actualsDir, '100x100_white.png');
    const expected = path.join(baselinesDir, '100x100_white.png');

    expect(() => {
      compareImages(actual, expected, { failureThreshold: NaN });
    }).toThrow('Invalid failureThreshold');
  });

  test('Adversarial: options.threshold out of bounds (negative) throws error', () => {
    const actual = path.join(actualsDir, '100x100_white.png');
    const expected = path.join(baselinesDir, '100x100_white.png');

    expect(() => {
      compareImages(actual, expected, { threshold: -0.5 });
    }).toThrow('Invalid threshold');
  });

  // 4. Object.create(null) for options
  test('Adversarial: options as Object.create(null)', () => {
    const actual = path.join(actualsDir, '100x100_white.png');
    const expected = path.join(baselinesDir, '100x100_white.png');
    const options = Object.create(null);
    options.threshold = 0.1;
    options.failureThreshold = 0.05;

    const result = compareImages(actual, expected, options);
    expect(result.pass).toBe(true);
  });

  // 5. Path Traversal in diffImagePath
  test('Adversarial: path traversal in diffImagePath writes outside intended directory throws error', () => {
    const diffActual = path.join(actualsDir, 'diff_actual.png');
    createMockPNG(diffActual, 100, 100, { r: 255, g: 0, b: 0, a: 255 });
    const expected = path.join(baselinesDir, '100x100_white.png');

    // Attempt to write outside process.cwd() and /tmp
    const traversalPath = path.resolve(process.cwd(), '../outside_diff.png');

    expect(() => {
      compareImages(diffActual, expected, {
        failureThreshold: 0,
        diffImagePath: traversalPath
      });
    }).toThrow('Path traversal detected in diffImagePath');
  });

  // 6. Absolute Path Traversal check in resolveBaseline
  test('Adversarial: resolveBaseline absolute path check', () => {
    // Passing an absolute path to resolveBaseline should trigger the path traversal guard
    const absolutePath = '/etc/passwd';
    expect(() => {
      resolveBaseline(absolutePath, baselinesDir);
    }).toThrow('Path traversal detected');
  });

  // 7. Directory as Image Path throws error
  test('Adversarial: actualImagePath is directory throws EISDIR', () => {
    const normalExpected = path.join(baselinesDir, '100x100_white.png');
    expect(() => {
      compareImages(actualsDir, normalExpected);
    }).toThrow();
  });

  // 8. Threshold out of bounds bypass
  test('Adversarial: threshold > 1 throws error', () => {
    const redActual = path.join(actualsDir, 'red.png');
    const greenExpected = path.join(baselinesDir, 'green.png');
    createMockPNG(redActual, 10, 10, { r: 255, g: 0, b: 0, a: 255 });
    createMockPNG(greenExpected, 10, 10, { r: 0, g: 255, b: 0, a: 255 });

    expect(() => {
      compareImages(redActual, greenExpected, { threshold: 2.5 });
    }).toThrow('Invalid threshold');
  });

  // 9. Symlink bypass in resolveBaseline
  test('Adversarial: symlink traversal resolves paths outside baselinesDir throws error', () => {
    const externalDir = path.join(tmpDir, 'external');
    fs.mkdirSync(externalDir, { recursive: true });
    
    // Create actual PNG target in external directory
    const externalTarget = path.join(externalDir, 'Secret.png');
    createMockPNG(externalTarget, 10, 10, { r: 255, g: 255, b: 255, a: 255 });

    // Symlink inside baselinesDir pointing to externalDir
    const symlinkPath = path.join(baselinesDir, 'components_symlink');
    if (!fs.existsSync(symlinkPath)) {
      fs.symlinkSync(externalDir, symlinkPath);
    }

    // This should now throw 'Path traversal detected' because we resolve symlinks and compare realpaths
    expect(() => {
      resolveBaseline('components_symlink/Secret.tsx', baselinesDir);
    }).toThrow('Path traversal detected');
  });

  // 10. Double-dot filename check
  test('Adversarial: filename starting with double-dots resolves successfully without path traversal error', () => {
    // Create baseline with double-dot prefix
    const doubleDotBaseline = path.join(baselinesDir, '..Button.png');
    createMockPNG(doubleDotBaseline, 10, 10, { r: 255, g: 255, b: 255, a: 255 });

    const resolved = resolveBaseline('..Button.tsx', baselinesDir);
    expect(resolved).toBe(path.resolve(doubleDotBaseline));

    // Cleanup double-dot baseline file
    if (fs.existsSync(doubleDotBaseline)) {
      fs.rmSync(doubleDotBaseline);
    }
  });

  // 11. Dynamic Inverse Padding check
  test('Adversarial: different size black images do not match due to dynamic inverse padding', () => {
    const black10 = path.join(actualsDir, 'black10.png');
    const black20 = path.join(baselinesDir, 'black20.png');

    createMockPNG(black10, 10, 10, { r: 0, g: 0, b: 0, a: 255 });
    createMockPNG(black20, 20, 20, { r: 0, g: 0, b: 0, a: 255 });

    const result = compareImages(black10, black20);
    // Since sizes differ, the padded region (300 pixels out of 400 total) must mismatch.
    expect(result.pass).toBe(false);
    expect(result.mismatchedPixels).toBe(300); // 400 - 100 = 300
    expect(result.diffRatio).toBe(300 / 400); // 0.75
  });
});
