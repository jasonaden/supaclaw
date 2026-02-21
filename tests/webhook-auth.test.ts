import { describe, it, expect } from 'vitest';
import {
  generateWebhookSecret,
  hashSecret,
  verifySecret,
} from '../src/webhook-auth';

describe('Webhook Auth', () => {
  describe('generateWebhookSecret', () => {
    it('should generate a secret starting with whsec_', () => {
      const secret = generateWebhookSecret();
      expect(secret).toMatch(/^whsec_[a-zA-Z0-9_-]+$/);
    });

    it('should generate unique secrets', () => {
      const a = generateWebhookSecret();
      const b = generateWebhookSecret();
      expect(a).not.toBe(b);
    });

    it('should generate secrets of sufficient length', () => {
      const secret = generateWebhookSecret();
      // whsec_ prefix (6) + at least 32 chars of randomness
      expect(secret.length).toBeGreaterThanOrEqual(38);
    });
  });

  describe('hashSecret / verifySecret', () => {
    it('should verify a correct secret against its hash', async () => {
      const secret = 'whsec_testSecret123';
      const hash = await hashSecret(secret);
      expect(await verifySecret(secret, hash)).toBe(true);
    });

    it('should reject an incorrect secret', async () => {
      const hash = await hashSecret('whsec_correct');
      expect(await verifySecret('whsec_wrong', hash)).toBe(false);
    });

    it('should produce different hashes for different secrets', async () => {
      const hash1 = await hashSecret('whsec_one');
      const hash2 = await hashSecret('whsec_two');
      expect(hash1).not.toBe(hash2);
    });
  });
});
