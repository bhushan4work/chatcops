import type { AnalyticsEvent, EventCount, EventQuery, EventSink } from '@chatcops/core';
import type { RedisLike } from './types.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Retain event hashes for 90 days
const DEFAULT_EVENT_TTL_MS = 90 * DAY_MS;

const WRITE_SCRIPT = `
local prefix = ARGV[1]
local ttl = tonumber(ARGV[2])

local i = 3
while i <= #ARGV do
  local hour = ARGV[i]
  local eventType = ARGV[i + 1]
  local hashKey = prefix .. ':events:' .. hour

  redis.call('ZADD', KEYS[1], tonumber(hour), hour)
  redis.call('HINCRBY', hashKey, eventType, 1)
  if ttl > 0 then
    redis.call('PEXPIRE', hashKey, ttl)
  end
  i = i + 2
end
return 1
`;

const QUERY_SCRIPT = `
local prefix = ARGV[1]
local from = tonumber(ARGV[2])
local to = tonumber(ARGV[3])
local filterType = ARGV[4]

local hours = redis.call('ZRANGEBYSCORE', KEYS[1], from, '(' .. to)
local results = {}

for _, hourStr in ipairs(hours) do
  local hashKey = prefix .. ':events:' .. hourStr
  local hour = tonumber(hourStr)
  if filterType ~= '' then
    local count = redis.call('HGET', hashKey, filterType)
    if count then
      table.insert(results, hour)
      table.insert(results, filterType)
      table.insert(results, tonumber(count))
    end
  else
    local all = redis.call('HGETALL', hashKey)
    for j = 1, #all, 2 do
      local t = all[j]
      local c = tonumber(all[j + 1])
      table.insert(results, hour)
      table.insert(results, t)
      table.insert(results, c)
    end
  end
end

return results
`;

export class RedisEventSink implements EventSink {
  private readonly hoursKey: string;

  constructor(
    private readonly redis: RedisLike,
    private readonly prefix: string,
    private readonly ttlMs: number = DEFAULT_EVENT_TTL_MS
  ) {
    this.hoursKey = `${this.prefix}:events:hours`;
  }

  async write(events: AnalyticsEvent[]): Promise<void> {
    if (events.length === 0) return;

    const pairs: (string | number)[] = [];
    for (const event of events) {
      const hour = Math.floor(event.timestamp / HOUR_MS) * HOUR_MS;
      pairs.push(hour, event.type);
    }

    await this.redis.eval(
      WRITE_SCRIPT,
      [this.hoursKey],
      [this.prefix, this.ttlMs, ...pairs]
    );
  }

  async query(query: EventQuery): Promise<EventCount[]> {
    const filterType = query.type ?? '';
    const res = await this.redis.eval<(string | number)[], (string | number)[]>(
      QUERY_SCRIPT,
      [this.hoursKey],
      [this.prefix, query.from, query.to, filterType]
    );

    const bucketSize = query.groupBy === 'hour' ? HOUR_MS : DAY_MS;
    const counts = new Map<string, EventCount>();

    if (res) {
      for (let i = 0; i < res.length; i += 3) {
        const hour = Number(res[i]);
        const type = String(res[i + 1]);
        const count = Number(res[i + 2]);

        const bucket = Math.floor(hour / bucketSize) * bucketSize;
        const key = `${bucket}:${type}`;
        const existing = counts.get(key);
        if (existing) {
          existing.count += count;
        } else {
          counts.set(key, { bucket, type, count });
        }
      }
    }

    return [...counts.values()].sort(
      (a, b) => a.bucket - b.bucket || (a.type < b.type ? -1 : 1)
    );
  }
}
