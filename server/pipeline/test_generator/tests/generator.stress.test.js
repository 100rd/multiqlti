const fs = require('fs/promises');
const path = require('path');
const { SpecTestGenerator } = require('../src/generator');
const { SpecGenerationError } = require('../src/errors');

describe('Spec-Derived Test Generator Stress Suite', () => {
  let tempDir;
  let targetPath;
  const specPath = path.join(__dirname, 'fixtures/sum.spec.md');

  beforeEach(async () => {
    const uniqueId = Math.random().toString(36).substring(2, 9);
    tempDir = path.join(__dirname, `temp_test_generator_sandbox_stress_${uniqueId}`);
    await fs.mkdir(tempDir, { recursive: true });
    targetPath = path.join(tempDir, 'sum.stress.test.js');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // --- 1. CONSTRUCTOR VALIDATION ---
  describe('Constructor Validation', () => {
    test('should throw Error if llmProvider is not provided', () => {
      expect(() => new SpecTestGenerator()).toThrow('LLMProvider is required');
    });

    test('should throw Error if llmProvider does not implement generateText method', () => {
      expect(() => new SpecTestGenerator({})).toThrow('llmProvider must implement generateText method');
    });
  });

  // --- 2. SPACING AND JEST MODIFIER WEAKNESSES (KEYWORDS CHECK) ---


  test('should throw SpecGenerationError if LLM response uses spaces before parentheses in Jest hooks', async () => {
    // Valid JS test suite but contains spaces between hook name and parenthesis: describe (
    const mockSpacingResponse = `
\`\`\`javascript
describe ('sum function spec-derived tests', () => {
  test ('adds 1 + 2 to equal 3', () => {
    expect (sum(1, 2)).toBe(3);
  });
});
\`\`\`
    `;

    const mockLLMProvider = {
      generateText: jest.fn().mockResolvedValue(mockSpacingResponse)
    };
    const generator = new SpecTestGenerator(mockLLMProvider);

    await expect(generator.generate(specPath, targetPath)).rejects.toThrow(SpecGenerationError);
    await expect(generator.generate(specPath, targetPath)).rejects.toThrow(
      /missing describe, test\/it, or expect/
    );
  });

  test('should throw SpecGenerationError if LLM response uses Jest focus/skip modifiers (e.g. describe.only, test.only)', async () => {
    // Valid JS test suite but uses describe.only and test.only which breaks exact string matches
    const mockModifierResponse = `
\`\`\`javascript
describe.only('sum function spec-derived tests', () => {
  test.only('adds 1 + 2 to equal 3', () => {
    expect(sum(1, 2)).toBe(3);
  });
});
\`\`\`
    `;

    const mockLLMProvider = {
      generateText: jest.fn().mockResolvedValue(mockModifierResponse)
    };
    const generator = new SpecTestGenerator(mockLLMProvider);

    await expect(generator.generate(specPath, targetPath)).rejects.toThrow(SpecGenerationError);
    await expect(generator.generate(specPath, targetPath)).rejects.toThrow(
      /missing describe, test\/it, or expect/
    );
  });

  // --- 2. MULTIPLE AND NESTED CODE BLOCKS ---

  test('should throw SpecGenerationError if response contains multiple code blocks and the first is not the test suite', async () => {
    const mockMultipleBlocksResponse = `
Here is the spec details:
\`\`\`javascript
// Not a test suite, just some config
const timeout = 5000;
\`\`\`

Here is the actual test suite:
\`\`\`javascript
describe('sum function', () => {
  test('adds 1 + 2', () => {
    expect(1 + 2).toBe(3);
  });
});
\`\`\`
    `;

    const mockLLMProvider = {
      generateText: jest.fn().mockResolvedValue(mockMultipleBlocksResponse)
    };
    const generator = new SpecTestGenerator(mockLLMProvider);

    await expect(generator.generate(specPath, targetPath)).rejects.toThrow(SpecGenerationError);
    await expect(generator.generate(specPath, targetPath)).rejects.toThrow(
      /missing describe, test\/it, or expect/
    );
  });

  test('should throw SpecGenerationError if nested backticks cause truncation and syntax errors', async () => {
    const mockNestedResponse = `
\`\`\`javascript
describe('sum function spec-derived tests', () => {
  test('handles nested backticks', () => {
    expect(1).toBe(1);
    const innerCode = \`
      \`\`\`javascript
      console.log("nested code block");
      \`\`\`
    \`;
  });
});
\`\`\`
    `;

    const mockLLMProvider = {
      generateText: jest.fn().mockResolvedValue(mockNestedResponse)
    };
    const generator = new SpecTestGenerator(mockLLMProvider);

    await expect(generator.generate(specPath, targetPath)).rejects.toThrow(SpecGenerationError);
    await expect(generator.generate(specPath, targetPath)).rejects.toThrow(
      /Generated JS code has syntax errors/
    );
  });

  // --- 3. SYSTEM AND FILE I/O SCENARIOS ---

  test('should throw SpecGenerationError if openSpecPath is a directory', async () => {
    const mockLLMProvider = {
      generateText: jest.fn()
    };
    const generator = new SpecTestGenerator(mockLLMProvider);

    // tempDir is a directory, not a file
    await expect(generator.generate(tempDir, targetPath)).rejects.toThrow(SpecGenerationError);
    await expect(generator.generate(tempDir, targetPath)).rejects.toThrow(
      /Failed to read specification file/
    );
  });

  test('should throw SpecGenerationError if targetTestPath is a directory', async () => {
    const mockLLMResponse = `
\`\`\`javascript
describe('sum function spec-derived tests', () => {
  test('adds 1 + 2 to equal 3', () => {
    expect(sum(1, 2)).toBe(3);
  });
});
\`\`\`
    `;

    const mockLLMProvider = {
      generateText: jest.fn().mockResolvedValue(mockLLMResponse)
    };
    const generator = new SpecTestGenerator(mockLLMProvider);

    // tempDir exists and is a directory, cannot write file directly to it (will fail to write)
    await expect(generator.generate(specPath, tempDir)).rejects.toThrow(SpecGenerationError);
    await expect(generator.generate(specPath, tempDir)).rejects.toThrow(
      /Failed to write test file/
    );
  });

  // --- 4. EXPLOITING NAIVE KEYWORD CHECKING (FALSE POSITIVE VULNERABILITY) ---

  test('should successfully write file despite NOT containing a valid test suite if keywords are in comments/strings', async () => {
    // This is a false positive: the code doesn't actually define Jest tests but contains all keywords
    const mockFalsePositiveResponse = `
\`\`\`javascript
// Naive bypass of keywords: describe( test( expect(
const dummy = "describe( test( expect(";
console.log(dummy);
\`\`\`
    `;

    const mockLLMProvider = {
      generateText: jest.fn().mockResolvedValue(mockFalsePositiveResponse)
    };
    const generator = new SpecTestGenerator(mockLLMProvider);

    // Should NOT throw because it is valid JS and contains the keyword substrings
    await generator.generate(specPath, targetPath);

    // Verify it got written
    const fileExists = await fs.access(targetPath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);

    const fileContent = await fs.readFile(targetPath, 'utf8');
    expect(fileContent).toContain('const dummy = "describe( test( expect(";');
  });

  // --- 5. EXTRA STRESS TESTS: NULL BYTES, INVALID TYPES, mkdir BLOCKED ---

  test('should throw SpecGenerationError if openSpecPath contains a null byte', async () => {
    const mockLLMProvider = { generateText: jest.fn() };
    const generator = new SpecTestGenerator(mockLLMProvider);

    await expect(generator.generate('spec\0path.md', targetPath)).rejects.toThrow(SpecGenerationError);
  });

  test('should throw SpecGenerationError if targetTestPath contains a null byte', async () => {
    const mockLLMProvider = { generateText: jest.fn() };
    const generator = new SpecTestGenerator(mockLLMProvider);

    await expect(generator.generate(specPath, 'target\0path.js')).rejects.toThrow(SpecGenerationError);
  });

  test('should throw SpecGenerationError for non-string openSpecPath types', async () => {
    const mockLLMProvider = { generateText: jest.fn() };
    const generator = new SpecTestGenerator(mockLLMProvider);

    await expect(generator.generate(42, targetPath)).rejects.toThrow(SpecGenerationError);
    await expect(generator.generate({}, targetPath)).rejects.toThrow(SpecGenerationError);
    await expect(generator.generate(true, targetPath)).rejects.toThrow(SpecGenerationError);
  });

  test('should throw SpecGenerationError for non-string targetTestPath types', async () => {
    const mockLLMProvider = { generateText: jest.fn() };
    const generator = new SpecTestGenerator(mockLLMProvider);

    await expect(generator.generate(specPath, 42)).rejects.toThrow(SpecGenerationError);
    await expect(generator.generate(specPath, [])).rejects.toThrow(SpecGenerationError);
    await expect(generator.generate(specPath, undefined)).rejects.toThrow(SpecGenerationError);
  });

  test('should throw SpecGenerationError if target directory creation is blocked by an existing file', async () => {
    const mockLLMResponse = `
\`\`\`javascript
describe('sum', () => {
  test('adds', () => {
    expect(1).toBe(1);
  });
});
\`\`\`
    `;
    const mockLLMProvider = {
      generateText: jest.fn().mockResolvedValue(mockLLMResponse)
    };
    const generator = new SpecTestGenerator(mockLLMProvider);

    // Create a file at the place where a directory is expected to be created
    const filePath = path.join(tempDir, 'blocked_dir');
    await fs.writeFile(filePath, 'some dummy data', 'utf8');

    // Attempt to write to a path inside 'blocked_dir' (which is a file, not a directory)
    const badTargetPath = path.join(filePath, 'nested', 'test.js');

    await expect(generator.generate(specPath, badTargetPath)).rejects.toThrow(SpecGenerationError);
    await expect(generator.generate(specPath, badTargetPath)).rejects.toThrow('Failed to write test file');
  });
});

