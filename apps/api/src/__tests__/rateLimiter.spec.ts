import { describe, expect, it } from 'vitest';
import { createInMemoryCache, createRateLimiter } from '../rateLimiter';

describe('rate limiter retry-after calculation', () => {
  it('returns remaining seconds until next token is available', async () => {
    const now = { value: 0 };
    const limiter = createRateLimiter({
      cache: createInMemoryCache(),
      capacity: 10,
      intervalMs: 60_000,
      bucketTtlSeconds: 120,
      now: () => now.value,
    });

    const key = 'team:test';
    for (let i = 0; i < 10; i += 1) {
      const result = await limiter.consume(key);
      expect(result.allowed).toBe(true);
    }

    const eleventh = await limiter.consume(key);
    expect(eleventh.allowed).toBe(false);
    expect(eleventh.retryAfterSeconds).toBe(6);

    now.value += 3_000;
    const twelfth = await limiter.consume(key);
    expect(twelfth.allowed).toBe(false);
    expect(twelfth.retryAfterSeconds).toBe(3);
  });
});
