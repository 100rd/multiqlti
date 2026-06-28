import { describe, it, expect } from 'vitest';
import { 
  ProviderPoolRouter, 
  RateLimitError, 
  NetworkError,
  ProviderExhaustionError,
  ProviderNode,
  AIRequest,
  AIProvider,
  AIResponse,
  AIProviderConfig
} from '../../../server/pipeline/v8_stubs/provider-pool-router.js';

class MockProvider implements AIProvider {
  constructor(
    public readonly id: string,
    public readonly name: string,
    private readonly simulateError?: Error
  ) {}

  async isAvailable(): Promise<boolean> {
    return !this.simulateError;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    if (this.simulateError) {
      throw this.simulateError;
    }
    return {
      content: `Response from ${this.name} to: "${request.messages[0]?.content || ''}"`,
      model: request.model,
      provider: this.id,
      usage: {
        promptTokens: 10,
        completionTokens: 10,
        totalTokens: 20
      }
    };
  }
}

describe('Workspace ProviderPoolRouter Verification', () => {
  const dummyRequest: AIRequest = {
    model: 'standard',
    messages: [{ role: 'user', content: 'test request' }]
  };

  // 1. Basic fallback & exhaustion
  it('R1/R2/R3: Primary returns 429 Too Many Requests -> transparently calls fallback and returns normalized response', async () => {
    const primary = new MockProvider('anthropic', 'Anthropic Cloud', new RateLimitError('Too Many Requests', 'anthropic'));
    const fallback = new MockProvider('lm-studio', 'LM Studio');
    const router = new ProviderPoolRouter(primary, fallback);

    const response = await router.route(dummyRequest);
    expect(response).toBeDefined();
    expect(response.provider).toBe('lm-studio');
    expect(response.content).toContain('LM Studio');
  });

  it('R1/R2: Both primary and fallback fail -> throws aggregate ProviderExhaustionError', async () => {
    const primary = new MockProvider('anthropic', 'Anthropic Cloud', new RateLimitError('Too Many Requests', 'anthropic'));
    const fallback = new MockProvider('lm-studio', 'LM Studio', new NetworkError('Local offline', 'lm-studio'));
    const router = new ProviderPoolRouter(primary, fallback);

    await expect(router.route(dummyRequest)).rejects.toThrow(ProviderExhaustionError);

    try {
      await router.route(dummyRequest);
    } catch (err: any) {
      expect(err).toBeInstanceOf(ProviderExhaustionError);
      expect(err.errors).toHaveLength(2);
      expect(err.errors[0].providerId).toBe('anthropic');
      expect(err.errors[0].error).toBeInstanceOf(RateLimitError);
      expect(err.errors[1].providerId).toBe('lm-studio');
      expect(err.errors[1].error).toBeInstanceOf(NetworkError);
    }
  });

  // 2. Zero/Negative Weights Edge Case
  it('Node pool containing zero and negative weights routes successfully (weights default to 1)', () => {
    const nodeA: ProviderNode = { provider: 'openai', weight: 0, isHealthy: true, lastChecked: new Date() };
    const nodeB: ProviderNode = { provider: 'openai', weight: -5, isHealthy: true, lastChecked: new Date() };
    const nodeC: ProviderNode = { provider: 'openai', weight: 10, isHealthy: true, lastChecked: new Date() };

    const router = new ProviderPoolRouter([nodeA, nodeB, nodeC]);
    const model = { provider: 'openai', slug: 'gpt-4' };

    const first = router.routeRequest(model);
    const second = router.routeRequest(model);
    const third = router.routeRequest(model);
    const fourth = router.routeRequest(model);

    expect(first).toBe(nodeA);
    expect(second).toBe(nodeB);
    expect(third).toBe(nodeC);
    expect(fourth).toBe(nodeC); // nodeC has weight 10, so it replicates 10 times
  });

  // 3. Invalid Model Properties
  it('Handling of invalid/null/undefined model properties in routeRequest', () => {
    const nodeA: ProviderNode = { provider: 'openai', weight: 1, isHealthy: true, lastChecked: new Date() };
    const router = new ProviderPoolRouter([nodeA]);

    expect(() => router.routeRequest(null as any)).toThrow();
    expect(() => router.routeRequest(undefined as any)).toThrow();

    const emptyModel = {} as any;
    expect(() => router.routeRequest(emptyModel)).toThrow("Invalid model: provider is null or undefined");
  });

  // 4. Parallel requests concurrency test
  it('Parallel requests do not cause race conditions or state corruption', async () => {
    const primary = new MockProvider('anthropic', 'Anthropic Cloud', new RateLimitError('Rate limit exceeded', 'anthropic'));
    const fallback = new MockProvider('lm-studio', 'LM Studio');
    const router = new ProviderPoolRouter(primary, fallback);

    const promises = Array.from({ length: 50 }).map(() => router.route(dummyRequest));
    const results = await Promise.all(promises);

    expect(results).toHaveLength(50);
    results.forEach((res) => {
      expect(res.provider).toBe('lm-studio');
    });
  });

  // 5. Round-Robin Counter Overflow
  it('Round-robin index overflow does NOT lead to stuck routing cycle due to wrapping', () => {
    const nodeA: ProviderNode = { provider: 'openai', weight: 1, isHealthy: true, lastChecked: new Date() };
    const nodeB: ProviderNode = { provider: 'openai', weight: 1, isHealthy: true, lastChecked: new Date() };
    const router = new ProviderPoolRouter([nodeA, nodeB]);
    const model = { provider: 'openai', slug: 'gpt-4' };

    (router as any).rrIndex = Number.MAX_SAFE_INTEGER - 1;

    expect(router.routeRequest(model)).toBe(nodeA);
    expect(router.routeRequest(model)).toBe(nodeB);
    expect(router.routeRequest(model)).toBe(nodeA);
    // With wrapping, it continues to cycle and does not get stuck
    expect(router.routeRequest(model)).toBe(nodeB);
    expect(router.routeRequest(model)).toBe(nodeA);
  });

  // 6. Auditor compliance methods (severance mode & evaluator independence)
  it('Auditor severance mode and evaluator independence', () => {
    const router = new ProviderPoolRouter();
    
    const p1: AIProviderConfig = { provider: 'openai-api', family: 'openai', isEnabled: true };
    const p2: AIProviderConfig = { provider: 'anthropic-api', family: 'anthropic', isEnabled: true };
    const pLocal: AIProviderConfig = { provider: 'local-ollama', family: 'self-hosted-local', isEnabled: true };

    router.registerProvider(p1);
    router.registerProvider(p2);
    router.registerProvider(pLocal);

    expect(router.routeCall('worker')).toBe(p1);
    expect(router.routeCall('evaluator', 'openai')).toBe(p2);
    expect(router.routeCall('evaluator', 'anthropic')).toBe(p1);

    router.setSeveranceMode(true);
    expect(router.routeCall('worker')).toBe(pLocal);
    expect(router.routeCall('evaluator', 'openai')).toBe(pLocal);

    const emptyRouter = new ProviderPoolRouter();
    emptyRouter.registerProvider(p1);
    emptyRouter.setSeveranceMode(true);
    expect(() => emptyRouter.routeCall('worker')).toThrow('CRITICAL: Severance fallback triggered but no local provider registered');
  });
});
