import { describe, it, expect } from 'vitest';
import { generateWebhookSecret, hashSecret } from '../src/webhook-auth';

// Webhook CLI logic test — the CLI commands are plumbing
// that call these functions + Supabase CRUD.

describe('Webhook CLI logic', () => {
  it('should generate a secret and produce a valid hash', async () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith('whsec_')).toBe(true);

    const hash = await hashSecret(secret);
    expect(hash).toBeDefined();
    expect(hash.length).toBe(64); // SHA-256 hex = 64 chars
  });
});
