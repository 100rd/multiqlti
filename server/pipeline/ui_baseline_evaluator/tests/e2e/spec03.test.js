const fs = require('fs');
const path = require('path');
const { resolveBaseline } = require('../../src/baseline-resolver');
const { compareImages } = require('../../src/pixel-comparator');
const { BaselineMissingError } = require('../../src/errors');
const { createMockPNG } = require('../helpers');

describe('SPEC-03 UI Baselines Evaluator - End-to-End Tests', () => {
  const tmpDir = path.resolve(__dirname, '../../tmp-test-fixtures');
  const baselinesDir = path.join(tmpDir, 'baselines');
  const actualsDir = path.join(tmpDir, 'actuals');
  const diffsDir = path.join(tmpDir, 'diffs');

  beforeAll(() => {
    // Ensure directories exist
    fs.mkdirSync(baselinesDir, { recursive: true });
    fs.mkdirSync(actualsDir, { recursive: true });
    fs.mkdirSync(diffsDir, { recursive: true });

    // Tier 1: Identical images setup
    // 100x100 white image
    createMockPNG(path.join(baselinesDir, 'Button.png'), 100, 100, { r: 255, g: 255, b: 255, a: 255 });
    createMockPNG(path.join(actualsDir, 'Button.png'), 100, 100, { r: 255, g: 255, b: 255, a: 255 });

    // Tier 2: 1% difference image setup (100x100 = 10,000 pixels. 10x10 red block = 100 pixels = 1%)
    createMockPNG(path.join(baselinesDir, 'Card.png'), 100, 100, { r: 255, g: 255, b: 255, a: 255 });
    createMockPNG(path.join(actualsDir, 'Card.png'), 100, 100, { r: 255, g: 255, b: 255, a: 255 }, [
      { type: 'rect', x: 0, y: 0, w: 10, h: 10, color: { r: 255, g: 0, b: 0, a: 255 } }
    ]);

    // Tier 3: Nested baseline resolver setup
    fs.mkdirSync(path.join(baselinesDir, 'components'), { recursive: true });
    createMockPNG(path.join(baselinesDir, 'components/Header.png'), 100, 100, { r: 255, g: 255, b: 255, a: 255 });
  });

  afterAll(() => {
    // Cleanup generated fixtures
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Tier 1: Happy-path comparison
  test('Tier 1: Happy path comparison with identical images', () => {
    const baselinePath = path.join(baselinesDir, 'Button.png');
    const actualPath = path.join(actualsDir, 'Button.png');

    const result = compareImages(actualPath, baselinePath);
    expect(result.pass).toBe(true);
    expect(result.diffRatio).toBe(0);
    expect(result.diffPercentage).toBe('0.00%');
    expect(result.totalPixels).toBe(10000);
    expect(result.mismatchedPixels).toBe(0);
  });

  // Tier 2: Boundary cases - 1% difference & threshold testing
  test('Tier 2: Boundary case - 1% diff fails with low failureThreshold and generates diff PNG', () => {
    const baselinePath = path.join(baselinesDir, 'Card.png');
    const actualPath = path.join(actualsDir, 'Card.png');
    const diffPath = path.join(diffsDir, 'Card_diff.png');

    const result = compareImages(actualPath, baselinePath, {
      failureThreshold: 0.001, // 0.1% allowed
      diffImagePath: diffPath
    });

    expect(result.pass).toBe(false);
    expect(result.diffRatio).toBeCloseTo(0.01, 5);
    expect(result.diffPercentage).toBe('1.00%');
    expect(fs.existsSync(diffPath)).toBe(true);
  });

  test('Tier 2: Boundary case - 1% diff passes with higher failureThreshold (e.g. 2%)', () => {
    const baselinePath = path.join(baselinesDir, 'Card.png');
    const actualPath = path.join(actualsDir, 'Card.png');

    const result = compareImages(actualPath, baselinePath, {
      failureThreshold: 0.02 // 2% allowed
    });

    expect(result.pass).toBe(true);
  });

  // Tier 3: Baseline resolution
  test('Tier 3: Baseline resolver resolves flat baseline', () => {
    const resolved = resolveBaseline('Button.tsx', baselinesDir);
    expect(resolved).toBe(path.join(baselinesDir, 'Button.png'));
  });

  test('Tier 3: Baseline resolver resolves nested baseline', () => {
    const resolved = resolveBaseline('components/Header.jsx', baselinesDir);
    expect(resolved).toBe(path.join(baselinesDir, 'components/Header.png'));
  });

  test('Tier 3: Baseline resolver falls back to flat baseline if nested does not exist', () => {
    // components/Button.tsx does not exist in baselines/components/, but Button.png exists in baselines/
    const resolved = resolveBaseline('components/Button.tsx', baselinesDir);
    expect(resolved).toBe(path.join(baselinesDir, 'Button.png'));
  });

  test('Tier 3: Baseline resolver throws BaselineMissingError if not found in nested or flat', () => {
    expect(() => {
      resolveBaseline('NonExistentComponent.tsx', baselinesDir);
    }).toThrow(BaselineMissingError);
  });

  // Tier 4: Pipeline simulation
  test('Tier 4: Pipeline simulation verification', () => {
    const componentTask = 'components/Header.jsx';
    const actualTaskScreenshot = path.join(actualsDir, 'Header_actual.png');
    // Create an actual screenshot which has some diff
    createMockPNG(actualTaskScreenshot, 100, 100, { r: 255, g: 255, b: 255, a: 255 }, [
      { type: 'rect', x: 20, y: 20, w: 30, h: 30, color: { r: 0, g: 0, b: 255, a: 255 } }
    ]);

    // Pipeline steps:
    // 1. Resolve baseline
    let resolvedBaselinePath;
    try {
      resolvedBaselinePath = resolveBaseline(componentTask, baselinesDir);
    } catch (err) {
      resolvedBaselinePath = null;
    }
    expect(resolvedBaselinePath).toBe(path.join(baselinesDir, 'components/Header.png'));

    // 2. Compare screenshot
    const pipelineReportPath = path.join(diffsDir, 'pipeline_Header_diff.png');
    const result = compareImages(actualTaskScreenshot, resolvedBaselinePath, {
      threshold: 0.1,
      failureThreshold: 0.001,
      diffImagePath: pipelineReportPath
    });

    expect(result.pass).toBe(false);
    expect(result.mismatchedPixels).toBe(900); // 30x30 = 900 pixels
    expect(fs.existsSync(pipelineReportPath)).toBe(true);
  });
});
