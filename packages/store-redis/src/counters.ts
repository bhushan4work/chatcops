import type { CounterStore, CounterValue } from '@chatcops/core';
import { decodeEvalResult, formatSlotPrefix } from './adapter.js';
import type { RedisLike } from './types.js';

const INCREMENT_SCRIPT = `
local by = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

local serverTime = redis.call('TIME')
local now = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)

if ttl <= 0 then
  local pttl = redis.call('PTTL', KEYS[1])
  local newVal = by
  if pttl >= 0 then
    local current = redis.call('HGET', KEYS[1], 'value')
    if current then
      newVal = tonumber(current) + by
    end
    redis.call('DEL', KEYS[1])
  end
  return cjson.encode({ tostring(newVal), tostring(now) })
end

local pttl = redis.call('PTTL', KEYS[1])

if pttl < 0 then
  local newVal = by
  local expiresAt = now + ttl
  redis.call('HSET', KEYS[1], 'value', tostring(newVal), 'expiresAt', tostring(expiresAt))
  redis.call('PEXPIRE', KEYS[1], ttl)
  return cjson.encode({ tostring(newVal), tostring(expiresAt) })
else
  local current = redis.call('HGET', KEYS[1], 'value')
  local newVal = (current and tonumber(current) or 0) + by
  local expiresAt = now + pttl
  redis.call('HSET', KEYS[1], 'value', tostring(newVal), 'expiresAt', tostring(expiresAt))
  return cjson.encode({ tostring(newVal), tostring(expiresAt) })
end
`;

const GET_SCRIPT = `
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 0 then
  return nil
end

local serverTime = redis.call('TIME')
local now = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)

local val = redis.call('HGET', KEYS[1], 'value')
if not val then
  return nil
end

local expiresAt = now + pttl
return cjson.encode({ tostring(val), tostring(expiresAt) })
`;

export class RedisCounterStore implements CounterStore {
  private readonly slotPrefix: string;

  constructor(
    private readonly redis: RedisLike,
    prefix: string
  ) {
    this.slotPrefix = formatSlotPrefix(prefix);
  }

  private key(key: string): string {
    return `${this.slotPrefix}:counter:${key}`;
  }

  async increment(key: string, by: number, ttlMs: number): Promise<CounterValue> {
    const roundedTtl = Math.ceil(ttlMs);
    const raw = await this.redis.eval<[number, number], unknown>(
      INCREMENT_SCRIPT,
      [this.key(key)],
      [by, roundedTtl]
    );

    const res = decodeEvalResult<[string, string]>(raw);
    return {
      value: Number(res[0]),
      expiresAt: Number(res[1]),
    };
  }

  async get(key: string): Promise<CounterValue | null> {
    const raw = await this.redis.eval<[], unknown>(
      GET_SCRIPT,
      [this.key(key)],
      []
    );

    if (!raw) return null;
    const res = decodeEvalResult<[string, string] | null>(raw);
    if (!res) return null;

    return {
      value: Number(res[0]),
      expiresAt: Number(res[1]),
    };
  }
}
