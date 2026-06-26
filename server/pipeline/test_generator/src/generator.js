const fs = require('fs/promises');
const path = require('path');
const vm = require('vm');
const { SpecGenerationError } = require('./errors');

class SpecTestGenerator {
  constructor(llmProvider) {
    if (!llmProvider) {
      throw new Error('LLMProvider is required');
    }
    if (typeof llmProvider.generateText !== 'function') {
      throw new Error('llmProvider must implement generateText method');
    }
    this.llmProvider = llmProvider;
  }

  async generate(openSpecPath, targetTestPath) {
    try {
      // Validate input parameters
      if (typeof openSpecPath !== 'string' || !openSpecPath.trim()) {
        throw new Error('openSpecPath must be a non-empty string');
      }
      if (typeof targetTestPath !== 'string' || !targetTestPath.trim()) {
        throw new Error('targetTestPath must be a non-empty string');
      }

      // Read specification file
      let specContent;
      try {
        specContent = await fs.readFile(openSpecPath, 'utf8');
      } catch (err) {
        throw new Error(`Failed to read specification file: ${err.message}`);
      }

      if (!specContent || !specContent.trim()) {
        throw new Error('OpenSpec content is empty');
      }

      // Format prompt
      const prompt = `You are a test generation agent. Generate an executable Jest test suite (JS) based on the following OpenSpec requirements:

---
${specContent}
---

Your response must contain ONLY the executable Jest test suite enclosed in a markdown code block starting with \`\`\`javascript.
Do not include any introductory or concluding text outside the code block.
Make sure the tests use standard Jest hooks (describe, test, expect) and import or require the target module correctly.`;

      // Invoke LLM provider
      let response;
      try {
        response = await this.llmProvider.generateText(prompt);
      } catch (err) {
        throw new Error(`LLM generation failed: ${err.message}`);
      }

      if (!response || !response.trim()) {
        throw new Error('LLM response is empty');
      }

      // Clean output
      const codeBlockRegex = /```(?:javascript|js)\s*([\s\S]*?)```/i;
      const match = response.match(codeBlockRegex);
      let extracted = '';
      if (match && match[1]) {
        extracted = match[1].trim();
      } else {
        const genericRegex = /```\s*([\s\S]*?)```/;
        const genericMatch = response.match(genericRegex);
        if (genericMatch && genericMatch[1]) {
          extracted = genericMatch[1].trim();
        } else {
          extracted = response.trim();
        }
      }

      if (!extracted) {
        throw new Error('Failed to extract test code from LLM response.');
      }

      // Validate Jest keywords
      const hasDescribe = extracted.includes('describe(');
      const hasTestOrIt = extracted.includes('test(') || extracted.includes('it(');
      const hasExpect = extracted.includes('expect(');
      if (!hasDescribe || !hasTestOrIt || !hasExpect) {
        throw new Error('LLM response is malformed: Extracted code does not appear to contain a valid Jest test suite (missing describe, test/it, or expect).');
      }

      // Validate JS syntax using vm.Script compilation
      try {
        new vm.Script(extracted);
      } catch (err) {
        throw new Error(`Generated JS code has syntax errors: ${err.message}`);
      }

      // Write target test path (ensure recursive directories)
      try {
        const targetDir = path.dirname(targetTestPath);
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(targetTestPath, extracted, 'utf8');
      } catch (err) {
        throw new Error(`Failed to write test file: ${err.message}`);
      }

    } catch (error) {
      if (error instanceof SpecGenerationError) {
        throw error;
      }
      throw new SpecGenerationError(error.message);
    }
  }
}

module.exports = {
  SpecTestGenerator
};
