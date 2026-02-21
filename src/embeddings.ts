import OpenAI from 'openai';
import { wrapEmbeddingOperation } from './error-handling';

export interface EmbeddingConfig {
  embeddingProvider?: string;
  openaiApiKey?: string;
  embeddingModel?: string;
}

/**
 * Generate embedding for text using configured provider
 */
export async function generateEmbedding(
  text: string,
  config: EmbeddingConfig,
  openai?: OpenAI
): Promise<number[] | null> {
  if (!config.embeddingProvider || config.embeddingProvider === 'none') {
    return null;
  }

  if (config.embeddingProvider === 'openai') {
    if (!openai) {
      throw new Error('OpenAI API key not provided');
    }

    const model = config.embeddingModel || 'text-embedding-3-small';
    return wrapEmbeddingOperation(async () => {
      const response = await openai.embeddings.create({
        model,
        input: text,
      });

      return response.data[0]!.embedding;
    }, 'generateEmbedding');
  }

  // TODO: Add Voyage AI support
  if (config.embeddingProvider === 'voyage') {
    throw new Error('Voyage AI embeddings not yet implemented');
  }

  return null;
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}
