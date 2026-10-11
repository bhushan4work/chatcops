import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

vi.mock('@chatcops/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chatcops/core')>();
  return {
    ...actual,
    createProvider: vi.fn().mockResolvedValue({
      name: 'test-provider',
      async *chat() {
        yield 'Hello';
      },
      async chatSync() {
        return 'Hello';
      },
    }),
  };
});

import { chatcopsAnalyticsHandler, chatcopsMiddleware } from '../../src/adapters/express.js';
import type { ChatCopsServerConfig } from '../../src/config.js';

function createRequest(method: string, body?: unknown): Request {
  return {
    method,
    body,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

type FakeResponse = {
  statusCode: number;
  headers: Record<string, unknown>;
  chunks: string[];
  body: unknown;
  ended: boolean;
  setHeader: (name: string, value: unknown) => void;
  status: (code: number) => FakeResponse;
  json: (payload: unknown) => FakeResponse;
  write: (chunk: string) => boolean;
  end: () => FakeResponse;
};

function createResponse(): { fake: FakeResponse; res: Response } {
  const fake: FakeResponse = {
    statusCode: 200,
    headers: {},
    chunks: [],
    body: undefined,
    ended: false,
    setHeader: (name, value) => {
      fake.headers[name] = value;
    },
    status: (code) => {
      fake.statusCode = code;
      return fake;
    },
    json: (payload) => {
      fake.body = payload;
      return fake;
    },
    write: (chunk) => {
      fake.chunks.push(chunk);
      return true;
    },
    end: () => {
      fake.ended = true;
      return fake;
    },
  };
  return { fake, res: fake as unknown as Response };
}

describe('express analytics sharing', () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
  });

  afterEach(() => {
    for (const result of setIntervalSpy.mock.results) {
      clearInterval(result.value as ReturnType<typeof setInterval>);
    }
    vi.restoreAllMocks();
  });

  it('reports middleware traffic through chatcopsAnalyticsHandler', async () => {
    const config: ChatCopsServerConfig = {
      provider: { type: 'claude', apiKey: 'test-key' },
      systemPrompt: 'Test',
      cors: '*',
      analytics: true,
    };

    const middleware = chatcopsMiddleware(config);

    for (const conversationId of ['conv-1', 'conv-2']) {
      const { fake, res } = createResponse();
      await middleware(
        createRequest('POST', { conversationId, message: 'Hello' }),
        res,
        (() => undefined) as NextFunction
      );
      expect(fake.chunks.join('')).toContain('data: [DONE]');
      expect(fake.ended).toBe(true);
    }

    const { fake: statsFake, res: statsRes } = createResponse();
    chatcopsAnalyticsHandler(config)(createRequest('GET'), statsRes);

    expect(statsFake.body).toMatchObject({ totalConversations: 2 });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
