import type { ChatMessage, Conversation } from '@chatcops/core';
import { Redis } from '@upstash/redis';
import RedisIo from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromIoRedis, redisStorage } from '../src/index.js';
import type { RedisLike } from '../src/types.js';

const redisUrl = process.env.CHATCOPS_TEST_REDIS_URL;
const upstashUrl = process.env.CHATCOPS_TEST_UPSTASH_URL;
const upstashToken = process.env.CHATCOPS_TEST_UPSTASH_TOKEN;

function msg(id: string, text: string): ChatMessage {
  return {
    id,
    role: 'user',
    content: text,
    timestamp: Date.now(),
  };
}

function runRegressionSuite(
  clientName: string,
  createClient: () => { redis: RedisLike; cleanup: () => Promise<void> }
) {
  describe(`regression tests: ${clientName}`, () => {
    let redis: RedisLike;
    let cleanup: () => Promise<void>;

    beforeAll(() => {
      const res = createClient();
      redis = res.redis;
      cleanup = res.cleanup;
    });

    afterAll(async () => {
      await cleanup?.();
    });

    describe('1. KV serialization exact value types & TTL', () => {
      it('preserves exact string types without double parsing', async () => {
        const prefix = `test-kv-ser-${Date.now().toString(36)}`;
        const storage = redisStorage({ redis, prefix });

        // String numbers, booleans, null, json-strings
        await storage.kv?.set('s_num', '123');
        await storage.kv?.set('s_bool_t', 'true');
        await storage.kv?.set('s_bool_f', 'false');
        await storage.kv?.set('s_null', 'null');
        await storage.kv?.set('s_json', '{"a":1}');

        // Actual numbers, booleans, null, objects, arrays
        await storage.kv?.set('val_num', 123);
        await storage.kv?.set('val_bool', true);
        await storage.kv?.set('val_null', null);
        await storage.kv?.set('val_obj', { a: 1 });
        await storage.kv?.set('val_arr', [1, 2, 'three']);

        // Verify exact types and values
        const sNum = await storage.kv?.get('s_num');
        expect(typeof sNum).toBe('string');
        expect(sNum).toBe('123');

        const sBoolT = await storage.kv?.get('s_bool_t');
        expect(typeof sBoolT).toBe('string');
        expect(sBoolT).toBe('true');

        const sBoolF = await storage.kv?.get('s_bool_f');
        expect(typeof sBoolF).toBe('string');
        expect(sBoolF).toBe('false');

        const sNull = await storage.kv?.get('s_null');
        expect(typeof sNull).toBe('string');
        expect(sNull).toBe('null');

        const sJson = await storage.kv?.get('s_json');
        expect(typeof sJson).toBe('string');
        expect(sJson).toBe('{"a":1}');

        const valNum = await storage.kv?.get('val_num');
        expect(typeof valNum).toBe('number');
        expect(valNum).toBe(123);

        const valBool = await storage.kv?.get('val_bool');
        expect(typeof valBool).toBe('boolean');
        expect(valBool).toBe(true);

        const valNull = await storage.kv?.get('val_null');
        expect(valNull).toBeNull();

        const valObj = await storage.kv?.get('val_obj');
        expect(valObj).toEqual({ a: 1 });

        const valArr = await storage.kv?.get('val_arr');
        expect(valArr).toEqual([1, 2, 'three']);
      });

      it('matches memoryStorage for zero, omitted, and fractional TTLs', async () => {
        const prefix = `test-kv-ttl-${Date.now().toString(36)}`;
        const storage = redisStorage({ redis, prefix });

        // Zero TTL means immediate expiry
        await storage.kv?.set('zero_ttl', 'immediate', { ttlMs: 0 });
        expect(await storage.kv?.get('zero_ttl')).toBeNull();

        // Omitted TTL persists
        await storage.kv?.set('no_ttl', 'persists');
        expect(await storage.kv?.get('no_ttl')).toBe('persists');

        // Fractional TTL rounded with Math.ceil
        await storage.kv?.set('frac_ttl', 'rounded', { ttlMs: 150.2 });
        expect(await storage.kv?.get('frac_ttl')).toBe('rounded');

        // setIfAbsent with zero TTL returns true if absent, but immediately expires
        const absentZero = await storage.kv?.setIfAbsent?.('nx_zero', 'temp', { ttlMs: 0 });
        expect(absentZero).toBe(true);
        expect(await storage.kv?.get('nx_zero')).toBeNull();

        // setIfAbsent when key already exists
        await storage.kv?.set('existing', 'first');
        const absentExisting = await storage.kv?.setIfAbsent?.('existing', 'second');
        expect(absentExisting).toBe(false);
        expect(await storage.kv?.get('existing')).toBe('first');
      });
    });

    describe('2. Metadata precision & conversation IDs', () => {
      it('preserves empty arrays and large numbers in metadata across shallow merges', async () => {
        const prefix = `test-conv-meta-${Date.now().toString(36)}`;
        const storage = redisStorage({ redis, prefix });
        const id = `conv-meta-${Date.now().toString(36)}`;

        // Initial append with empty array and 1234567890123456
        await storage.conversations.append?.(id, [msg('m1', 'first')], {
          metadata: {
            emptyArr: [],
            bigNum: 1234567890123456,
            nested: { ok: true },
          },
        });

        const loaded1 = await storage.conversations.get(id);
        expect(loaded1?.metadata?.emptyArr).toEqual([]);
        expect(Array.isArray(loaded1?.metadata?.emptyArr)).toBe(true);
        expect(loaded1?.metadata?.bigNum).toBe(1234567890123456);

        // Shallow merge on append without altering existing fields
        await storage.conversations.append?.(id, [msg('m2', 'second')], {
          metadata: {
            patchedField: 'new-val',
          },
        });

        const loaded2 = await storage.conversations.get(id);
        expect(loaded2?.metadata?.emptyArr).toEqual([]);
        expect(Array.isArray(loaded2?.metadata?.emptyArr)).toBe(true);
        expect(loaded2?.metadata?.bigNum).toBe(1234567890123456);
        expect(loaded2?.metadata?.patchedField).toBe('new-val');
        expect(loaded2?.metadata?.nested).toEqual({ ok: true });

        // Save round trip with empty arrays and big numbers
        const saveId = `save-${Date.now().toString(36)}`;
        const conv: Conversation = {
          id: saveId,
          messages: [msg('s1', 'saved')],
          metadata: {
            tags: [],
            large: 1234567890123456,
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await storage.conversations.save(conv);

        const loadedSaved = await storage.conversations.get(saveId);
        expect(loadedSaved?.metadata?.tags).toEqual([]);
        expect(Array.isArray(loadedSaved?.metadata?.tags)).toBe(true);
        expect(loadedSaved?.metadata?.large).toBe(1234567890123456);
      });

      it('preserves conversation ids such as "[1]" in get() and list()', async () => {
        const prefix = `test-conv-id-${Date.now().toString(36)}`;
        const storage = redisStorage({ redis, prefix });
        const specialId = '[1]';

        await storage.conversations.append?.(specialId, [msg('m1', 'hello')]);

        // get() preserves "[1]"
        const c = await storage.conversations.get(specialId);
        expect(c).not.toBeNull();
        expect(c?.id).toBe('[1]');
        expect(typeof c?.id).toBe('string');

        // list() preserves "[1]"
        const listed = await storage.conversations.list?.({ limit: 10 });
        const found = listed?.items.find((i) => i.id === specialId);
        expect(found).toBeDefined();
        expect(found?.id).toBe('[1]');
        expect(typeof found?.id).toBe('string');

        await storage.conversations.delete(specialId);
      });
    });

    describe('3. Counters fractional increments and expiry derivation', () => {
      it('preserves fractional increments such as 0.5 without integer truncation', async () => {
        const prefix = `test-cnt-frac-${Date.now().toString(36)}`;
        const storage = redisStorage({ redis, prefix });
        const key = 'fractional_key';

        const res1 = await storage.counters?.increment(key, 0.5, 60_000);
        expect(res1?.value).toBe(0.5);

        const res2 = await storage.counters?.increment(key, 1.5, 60_000);
        expect(res2?.value).toBe(2);

        const res3 = await storage.counters?.increment(key, 0.25, 60_000);
        expect(res3?.value).toBe(2.25);

        const current = await storage.counters?.get(key);
        expect(current?.value).toBe(2.25);
      });

      it('derives expiry from Redis actual server time/TTL and does not reset expiry on existing keys', async () => {
        const prefix = `test-cnt-exp-${Date.now().toString(36)}`;
        const storage = redisStorage({ redis, prefix });
        const key = 'expiry_key';

        const first = await storage.counters?.increment(key, 1, 60_000);
        expect(first?.value).toBe(1);
        expect(first?.expiresAt).toBeDefined();

        await new Promise((r) => setTimeout(r, 20));

        const second = await storage.counters?.increment(key, 2, 60_000);
        expect(second?.value).toBe(3);
        // Expiry on existing key should not have reset to now + 60_000
        if (first && second) {
          expect(Math.abs(second.expiresAt - first.expiresAt)).toBeLessThanOrEqual(50);
        }
      });

      it('expires immediately with zero TTL', async () => {
        const prefix = `test-cnt-zero-${Date.now().toString(36)}`;
        const storage = redisStorage({ redis, prefix });
        const key = 'zero_cnt';

        const res = await storage.counters?.increment(key, 5, 0);
        expect(res?.value).toBe(5);

        // Immediate next get returns null
        expect(await storage.counters?.get(key)).toBeNull();
      });
    });

    describe('4. Events partial-hour query rounding', () => {
      it('selects hourly buckets accurately for partial-hour queries', async () => {
        const prefix = `test-ev-partial-${Date.now().toString(36)}`;
        const storage = redisStorage({ redis, prefix });

        const baseHour = Date.UTC(2026, 9, 21, 10, 0, 0);
        // Event at 10:15
        await storage.events?.write([
          { type: 'click', timestamp: baseHour + 15 * 60 * 1000 },
        ]);

        // Query with partial hour window [10:30, 10:45)
        // With hour rounding semantics, from is rounded down to 10:00 and to rounded up to 11:00
        const res = await storage.events?.query?.({
          type: 'click',
          from: baseHour + 30 * 60 * 1000,
          to: baseHour + 45 * 60 * 1000,
          groupBy: 'hour',
        });

        expect(res).toEqual([
          { bucket: baseHour, type: 'click', count: 1 },
        ]);
      });
    });

    describe('5. Pagination using ZREVRANGEBYSCORE LIMIT', () => {
      it('paginates correctly using cursor without full sorted set loads', async () => {
        const prefix = `test-conv-page-${Date.now().toString(36)}`;
        const storage = redisStorage({ redis, prefix });

        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          const id = `p_${i}_${Date.now().toString(36)}`;
          ids.push(id);
          await storage.conversations.append?.(id, [msg(`m_${i}`, `hello ${i}`)]);
          await new Promise((r) => setTimeout(r, 10));
        }

        // Page 1 with limit 2
        const p1 = await storage.conversations.list?.({ limit: 2 });
        expect(p1?.items).toHaveLength(2);
        expect(p1?.cursor).toBeDefined();

        // Page 2 with limit 2
        const p2 = await storage.conversations.list?.({ limit: 2, cursor: p1?.cursor });
        expect(p2?.items).toHaveLength(2);
        expect(p2?.cursor).toBeDefined();

        // Page 3 with limit 2 (should return the 5th item)
        const p3 = await storage.conversations.list?.({ limit: 2, cursor: p2?.cursor });
        expect(p3?.items.length).toBeGreaterThanOrEqual(1);

        const allSeenIds = [
          ...(p1?.items.map((i) => i.id) ?? []),
          ...(p2?.items.map((i) => i.id) ?? []),
          ...(p3?.items.map((i) => i.id) ?? []),
        ];

        // No duplicate IDs across pages
        expect(new Set(allSeenIds).size).toBe(allSeenIds.length);
      });
    });
  });
}

if (redisUrl) {
  runRegressionSuite('ioredis', () => {
    const io = new RedisIo(redisUrl, { maxRetriesPerRequest: 3 });
    return {
      redis: fromIoRedis(io),
      cleanup: async () => {
        await io.quit();
      },
    };
  });
} else {
  describe.skip('regression suite: ioredis (set CHATCOPS_TEST_REDIS_URL to run)', () => {});
}

if (upstashUrl && upstashToken) {
  runRegressionSuite('@upstash/redis', () => {
    const client = new Redis({ url: upstashUrl, token: upstashToken });
    return {
      redis: client,
      cleanup: async () => {},
    };
  });
} else {
  describe.skip('regression suite: @upstash/redis (set CHATCOPS_TEST_UPSTASH_URL and CHATCOPS_TEST_UPSTASH_TOKEN to run)', () => {});
}
