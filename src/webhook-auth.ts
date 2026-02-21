import { randomBytes, createHash } from 'crypto';

/**
 * Generate a new webhook secret with whsec_ prefix.
 */
export function generateWebhookSecret(): string {
  const random = randomBytes(32).toString('base64url');
  return `whsec_${random}`;
}

/**
 * Hash a webhook secret for storage.
 * Uses SHA-256 — sufficient for high-entropy random secrets.
 */
export async function hashSecret(secret: string): Promise<string> {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Verify a webhook secret against a stored hash.
 */
export async function verifySecret(secret: string, hash: string): Promise<boolean> {
  const computed = await hashSecret(secret);
  // Constant-time comparison to prevent timing attacks
  if (computed.length !== hash.length) return false;
  let result = 0;
  for (let i = 0; i < computed.length; i++) {
    result |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return result === 0;
}
