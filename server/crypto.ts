import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Encrypts gateway credentials at rest (AES-256-GCM) and signs session
 * tokens (HMAC-SHA256). Both keys are derived from APP_SECRET.
 */
export class SecretBox {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(secret: string) {
    if (!secret) throw new Error('APP_SECRET must not be empty');
    this.encKey = scryptSync(secret, 'sms-automation:enc:v1', 32);
    this.macKey = scryptSync(secret, 'sms-automation:mac:v1', 32);
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${Buffer.concat([iv, tag, data]).toString('base64')}`;
  }

  open(sealed: string): string {
    if (!sealed.startsWith('v1:')) throw new Error('Unsupported ciphertext format');
    const raw = Buffer.from(sealed.slice(3), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  sign(value: string): string {
    return createHmac('sha256', this.macKey).update(value).digest('base64url');
  }

  verify(value: string, signature: string): boolean {
    return safeEqual(this.sign(value), signature);
  }
}

/** Constant-time string comparison that doesn't leak length differences. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;
}
