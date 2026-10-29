// AES-256-GCM seal/unseal for a small secret payload (e.g. a customer-pasted
// API key), keyed by the same APP_ENCRYPTION_KEY services/integrations/mailbox.ts
// uses for OAuth tokens. Kept separate from mailbox.ts because its
// sealTokens/unsealTokens are coupled to MAILBOX_OAUTH_MOCK, which has no
// meaning for a key that is real from the moment it is entered. Same wire
// format either way: iv(12) + tag(16) + ciphertext, base64.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function getEncryptionKey(): Buffer {
  const hex = process.env.APP_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) throw new Error("APP_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  return Buffer.from(hex, "hex");
}

/** Encrypt a small JSON-serializable secret (e.g. a pasted API key) at rest. */
export function sealSecret(value: Record<string, unknown>): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/** Decrypt a value sealed by sealSecret. Throws on a corrupt or wrongly-keyed blob. */
export function unsealSecret(sealed: string): Record<string, unknown> {
  const key = getEncryptionKey();
  const buf = Buffer.from(sealed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as Record<string, unknown>;
}
