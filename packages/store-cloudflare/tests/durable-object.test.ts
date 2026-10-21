import { afterAll, describe, expect, it } from 'vitest';
import { cloudflareStorage } from '../src/index.js';
import { disposeMiniflare, getMiniflareBindings } from './miniflare.js';

describe('durable objects counters', () => {
  it('counts 50 concurrent increments exactly once', async () => {
    const { d1, counters } = await getMiniflareBindings();
    const storage = cloudflareStorage({ d1, counters });
    const key = `do-race-${Date.now()}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => storage.counters!.increment(key, 1, 60_000))
    );

    expect(results.map((r) => r.value).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1)
    );
    expect((await storage.counters!.get(key))?.value).toBe(50);
  });

  it('resets counter after ttl expires', async () => {
    const { d1, counters } = await getMiniflareBindings();
    const storage = cloudflareStorage({ d1, counters });
    const key = `do-ttl-${Date.now()}`;

    await storage.counters!.increment(key, 5, 50);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(await storage.counters!.get(key)).toBeNull();
    const next = await storage.counters!.increment(key, 2, 60_000);
    expect(next.value).toBe(2);
  });
});

afterAll(async () => {
  await disposeMiniflare();
});
