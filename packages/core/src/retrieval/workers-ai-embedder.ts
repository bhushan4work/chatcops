import type { Embedder } from './types.js';

export interface WorkersAiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface WorkersAiEmbedderOptions {
  /** The Cloudflare Workers AI binding (`env.AI`). */
  ai: WorkersAiBinding;
  /** Default `@cf/baai/bge-m3`. */
  model?: string;
  /** Vector length. Default 1024. */
  dimensions?: number;
  /** Max texts per `ai.run` call. Default 100, matching the model input limit. */
  batchSize?: number;
}

const DEFAULT_MODEL = '@cf/baai/bge-m3';
const DEFAULT_DIMENSIONS = 1024;
const DEFAULT_BATCH_SIZE = 100;

/**
 * Embeddings from Cloudflare Workers AI via binding (`env.AI`).
 * Calls `ai.run` in batches (default up to 100 texts), validating
 * response shape, vector count and dimensions.
 */
export function workersAiEmbedder(options: WorkersAiEmbedderOptions): Embedder {
  if (!options?.ai || typeof options.ai.run !== 'function') {
    throw new Error('workersAiEmbedder requires an ai binding with a run() method.');
  }

  const model = options.model ?? DEFAULT_MODEL;
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, DEFAULT_BATCH_SIZE));
  const ai = options.ai;

  async function request(batch: string[]): Promise<Float32Array[]> {
    const response = await ai.run(model, { text: batch });
    if (!response || typeof response !== 'object' || !('data' in response) || !Array.isArray((response as { data?: unknown }).data)) {
      throw new Error(`Workers AI returned an invalid response for ${model}.`);
    }
    const data = (response as { data: unknown[] }).data;
    if (data.length !== batch.length) {
      throw new Error(`Workers AI returned ${data.length} embeddings for ${batch.length} texts.`);
    }
    return data.map((embedding) => {
      if (!Array.isArray(embedding) && !(embedding instanceof Float32Array)) {
        throw new Error(`Workers AI returned an invalid embedding for ${model}.`);
      }
      if (embedding.length !== dimensions) {
        throw new Error(`Workers AI returned ${embedding.length} dimensions from ${model}, but the embedder is set to ${dimensions}.`);
      }
      return Float32Array.from(embedding as Iterable<number>);
    });
  }

  return {
    id: `workers-ai:${model}@${dimensions}`,
    dimensions,
    async embed(texts, _kind, embedOptions = {}) {
      if (embedOptions.signal?.aborted) {
        throw embedOptions.signal.reason;
      }
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        if (embedOptions.signal?.aborted) {
          throw embedOptions.signal.reason;
        }
        const batch = texts.slice(start, start + batchSize);
        vectors.push(...(await request(batch)));
      }
      return vectors;
    },
  };
}
