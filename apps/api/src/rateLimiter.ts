type CacheLike = {
  get<T = string>(key: string, options?: { type?: 'json' | 'text' }): Promise<T | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

export function createInMemoryCache(): CacheLike {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  return {
    async get(key: string, options?: { type?: 'json' | 'text' }) {
      const record = store.get(key);
      if (!record) return null;
      if (record.expiresAt && record.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }

      if (options?.type === 'json') {
        try {
          return JSON.parse(record.value);
        } catch {
          return null;
        }
      }

      return record.value;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      const expiresAt = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
      store.set(key, { value, expiresAt });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

type RateLimiterConfig = {
  cache: CacheLike;
  capacity: number;
  intervalMs: number;
  bucketTtlSeconds: number;
  now?: () => number;
};

type Bucket = {
  tokens: number;
  updatedAt: number;
};

export function createRateLimiter(config: RateLimiterConfig) {
  const { cache, capacity, intervalMs, bucketTtlSeconds, now = () => Date.now() } = config;

  return {
    async consume(key: string) {
      const bucketKey = `ratelimit:${key}`;
      const currentTime = now();
      const existing = await cache.get<Bucket>(bucketKey, { type: 'json' });

      let tokens = capacity;
      let updatedAt = currentTime;

      if (existing) {
        const elapsed = currentTime - existing.updatedAt;
        const refill = (elapsed / intervalMs) * capacity;
        tokens = Math.min(capacity, existing.tokens + refill);
        updatedAt = currentTime;
      }

      if (tokens < 1) {
        await cache.put(bucketKey, JSON.stringify({ tokens, updatedAt }), {
          expirationTtl: bucketTtlSeconds,
        });
        const msUntilNextToken = ((1 - tokens) / capacity) * intervalMs;
        const retryAfter = Math.ceil(msUntilNextToken / 1000);
        return { allowed: false, retryAfterSeconds: retryAfter };
      }

      tokens -= 1;
      await cache.put(bucketKey, JSON.stringify({ tokens, updatedAt }), {
        expirationTtl: bucketTtlSeconds,
      });
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
