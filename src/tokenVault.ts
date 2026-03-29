import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;

function decodeKeyMaterial(raw: string): Buffer {
  if (!raw || !raw.trim()) {
    throw new Error('TOKEN_VAULT_MASTER_KEY is required');
  }

  const value = raw.trim();

  if (value.startsWith('hex:')) {
    return Buffer.from(value.slice(4), 'hex');
  }

  if (value.startsWith('base64:')) {
    return Buffer.from(value.slice(7), 'base64');
  }

  return Buffer.from(value, 'utf8');
}

function normalizeKey(raw: string): Buffer {
  const material = decodeKeyMaterial(raw);

  // AES-256 requires 32 bytes. If key material is exactly 32 bytes, use as-is.
  if (material.length === 32) {
    return material;
  }

  // Otherwise derive a fixed-length key deterministically.
  return crypto.createHash('sha256').update(material).digest();
}

export class TokenVault {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    this.key = normalizeKey(masterKey);
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    return [
      'v1',
      iv.toString('base64'),
      tag.toString('base64'),
      encrypted.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');

    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('Invalid encrypted payload format');
    }

    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const encrypted = Buffer.from(parts[3], 'base64');

    if (iv.length !== IV_LENGTH) {
      throw new Error('Invalid IV length');
    }

    if (tag.length !== 16) {
      throw new Error('Invalid auth tag length');
    }

    const decipher = crypto.createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }
}
