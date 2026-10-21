import { afterAll, describe, expect, it } from 'vitest';
import {
  ChatCopsCounter,
  SCHEMA_VERSION,
  cloudflareStorage,
  initializeSchema,
} from '../src/index.js';
import { disposeMiniflare, getMiniflareBindings } from './miniflare.js';

describe('cloudflare storage options and edge cases', () => {
  it('throws when d1 is not provided', () => {
    expect(() => cloudflareStorage({} as any)).toThrow('cloudflareStorage requires a D1 database');
  });

  it('throws on unsupported schema version', async () => {
    const { d1 } = await getMiniflareBindings();
    await initializeSchema(d1);

    await d1
      .prepare('INSERT OR REPLACE INTO chatcops_meta (key, value) VALUES (?, ?)')
      .bind('schema_version', String(SCHEMA_VERSION + 1))
      .run();

    await expect(initializeSchema(d1)).rejects.toThrow('Unsupported ChatCops SQLite schema version');

    // restore version
    await d1
      .prepare('INSERT OR REPLACE INTO chatcops_meta (key, value) VALUES (?, ?)')
      .bind('schema_version', String(SCHEMA_VERSION))
      .run();
  });

  it('throws on invalid list cursor', async () => {
    const { d1 } = await getMiniflareBindings();
    const storage = cloudflareStorage({ d1 });
    await expect(storage.conversations.list?.({ limit: 10, cursor: 'invalid' })).rejects.toThrow(
      'Not a list cursor'
    );
  });

  it('handles empty events array without errors', async () => {
    const { d1 } = await getMiniflareBindings();
    const storage = cloudflareStorage({ d1 });
    await expect(storage.events?.write([])).resolves.toBeUndefined();
  });

  it('queries events by hour and with type filter', async () => {
    const { d1 } = await getMiniflareBindings();
    const storage = cloudflareStorage({ d1 });
    const now = Date.now();
    await storage.events?.write([
      { type: 'click', timestamp: now },
      { type: 'view', timestamp: now + 10 },
      { type: 'click', timestamp: now + 3600 * 1000 },
    ]);

    const byHourWithType = await storage.events?.query?.({
      from: now - 1000,
      to: now + 7200 * 1000,
      type: 'click',
      groupBy: 'hour',
    });
    expect(byHourWithType?.length).toBeGreaterThanOrEqual(1);

    const byDayAll = await storage.events?.query?.({
      from: now - 1000,
      to: now + 7200 * 1000,
      groupBy: 'day',
    });
    expect(byDayAll?.length).toBeGreaterThanOrEqual(1);
  });

  it('calls close without error', async () => {
    const { d1 } = await getMiniflareBindings();
    const storage = cloudflareStorage({ d1 });
    await expect(storage.close?.()).resolves.toBeUndefined();
  });

  it('supports KV set without ttl and KV delete', async () => {
    const { kv } = await getMiniflareBindings();
    const storage = cloudflareStorage({ d1: (await getMiniflareBindings()).d1, kv });
    await storage.kv?.set('no-ttl', { foo: 'bar' });
    expect(await storage.kv?.get('no-ttl')).toEqual({ foo: 'bar' });
    await storage.kv?.delete('no-ttl');
    expect(await storage.kv?.get('no-ttl')).toBeNull();
  });

  it('supports ChatCopsCounter direct unit calls with mock storage', async () => {
    const store = new Map<string, any>();
    const mockState = {
      id: { toString: () => 'id1', equals: () => true },
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, val: any) => store.set(key, val),
      },
      waitUntil: () => {},
    };

    const counter = new ChatCopsCounter(mockState as any, {});

    expect(await counter.get()).toBeNull();
    expect(await counter.get('custom')).toBeNull();

    const first = await counter.increment(1, 60_000);
    expect(first.value).toBe(1);

    const second = await counter.increment(3, 60_000);
    expect(second.value).toBe(4);
    expect(await counter.get()).toEqual(second);

    // Named key overload
    const named1 = await counter.increment('named', 10, 60_000);
    expect(named1.value).toBe(10);
    const named2 = await counter.increment('named', 5, 60_000);
    expect(named2.value).toBe(15);
    expect(await counter.get('named')).toEqual(named2);

    // Expired counter reset
    const expired = await counter.increment('exp', 10, -100);
    expect(await counter.get('exp')).toBeNull();
    const reset = await counter.increment('exp', 2, 60_000);
    expect(reset.value).toBe(2);
  });

  it('handles append with empty messages', async () => {
    const { d1 } = await getMiniflareBindings();
    const storage = cloudflareStorage({ d1 });
    const id = `empty-msg-${Date.now()}`;
    const res = await storage.conversations.append?.(id, [], { metadata: { tag: 'init' } });
    expect(res?.version).toBe(1);
    const conv = await storage.conversations.get(id);
    expect(conv?.version).toBe(1);
    expect(conv?.messages).toHaveLength(0);
    expect(conv?.metadata).toEqual({ tag: 'init' });
  });
});

afterAll(async () => {
  await disposeMiniflare();
});
