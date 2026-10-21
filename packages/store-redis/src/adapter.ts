import type { IoRedisLike, RedisLike, RedisSetOptions } from './types.js';

/**
 * Safely parses a JSON string into type T, or returns the original value if it is
 * already parsed or not valid JSON.
 */
export function parseJson<T>(value: unknown): T {
  if (value === null || value === undefined) return null as T;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }
  return value as T;
}

/**
 * Safely decodes a result from an eval script.
 * If the client (like @upstash/redis) already automatically deserialized the result
 * from JSON, returns it directly. If it is a JSON string (like raw responses from ioredis),
 * parses it into the target type.
 */
export function decodeEvalResult<T>(value: unknown): T {
  if (value === null || value === undefined) return null as T;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }
  return value as T;
}

/**
 * Formats a prefix into a stable Redis Cluster hash slot tag.
 */
export function formatSlotPrefix(prefix: string): string {
  if (prefix.startsWith('{') && prefix.endsWith('}')) {
    return prefix;
  }
  return `{${prefix}}`;
}

/**
 * Adapts an ioredis client instance into the minimal RedisLike interface compatible
 * with @upstash/redis, correctly handling ioredis's eval(script, numKeys, ...keysAndArgs)
 * signature and JSON value parsing.
 */
export function fromIoRedis(redis: IoRedisLike): RedisLike {
  if (!redis) {
    throw new TypeError('fromIoRedis requires a redis client instance');
  }

  return {
    eval: async <TArgs extends unknown[] = unknown[], TData = unknown>(
      script: string,
      keys: string[] = [],
      args: TArgs = [] as unknown as TArgs
    ): Promise<TData> => {
      const numKeys = keys.length;
      const evalArgs = (args ?? []).map((a) =>
        typeof a === 'number' ? a : String(a)
      );
      const res = await redis.eval(script, numKeys, ...keys, ...evalArgs);
      return res as TData;
    },

    get: async <T = unknown>(key: string): Promise<T | null> => {
      const raw = await redis.get(key);
      if (raw === null || raw === undefined) return null;
      return parseJson<T>(raw);
    },

    set: async (key: string, value: unknown, opts?: RedisSetOptions): Promise<unknown> => {
      const valStr = typeof value === 'string' ? value : JSON.stringify(value);
      const args: (string | number)[] = [];
      if (opts?.ex !== undefined) {
        args.push('EX', opts.ex);
      } else if (opts?.px !== undefined) {
        args.push('PX', opts.px);
      }
      if (opts?.nx) {
        args.push('NX');
      } else if (opts?.xx) {
        args.push('XX');
      }
      if (opts?.keepttl) {
        args.push('KEEPTTL');
      }
      return redis.set(key, valStr, ...args);
    },

    del: (...keys: string[]): Promise<number> => {
      if (keys.length === 0) return Promise.resolve(0);
      return redis.del(...keys);
    },

    quit: () => (typeof redis.quit === 'function' ? redis.quit() : Promise.resolve()),
    close: () => (typeof redis.quit === 'function' ? redis.quit() : Promise.resolve()),
    disconnect: () => {
      if (typeof redis.disconnect === 'function') redis.disconnect();
    },
  };
}
