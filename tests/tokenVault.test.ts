import { describe, expect, it } from 'vitest';
import { TokenVault } from '../src/tokenVault';

describe('TokenVault', () => {
  const vault = new TokenVault('base64:dGhpcy1pcy1hLXRlc3QtbWFzdGVyLWtleS0zMmJ5dGVzISE=');

  it('encrypts and decrypts token roundtrip', () => {
    const token = 'sk-test-1234567890';

    const encrypted = vault.encrypt(token);
    const decrypted = vault.decrypt(encrypted);

    expect(encrypted).not.toEqual(token);
    expect(decrypted).toEqual(token);
  });

  it('uses random IV so encrypted payload changes across calls', () => {
    const token = 'same-token';

    const first = vault.encrypt(token);
    const second = vault.encrypt(token);

    expect(first).not.toEqual(second);
    expect(vault.decrypt(first)).toEqual(token);
    expect(vault.decrypt(second)).toEqual(token);
  });

  it('rejects invalid payload format', () => {
    expect(() => vault.decrypt('not-valid')).toThrow('Invalid encrypted payload format');
  });

  it('rejects tampered ciphertext/auth tag', () => {
    const token = 'sensitive-token';
    const encrypted = vault.encrypt(token);
    const parts = encrypted.split(':');

    // Mutate auth tag by flipping trailing chars.
    const badTag = parts[2].slice(0, -2) + 'AA';
    const tampered = [parts[0], parts[1], badTag, parts[3]].join(':');

    expect(() => vault.decrypt(tampered)).toThrow();
  });
});
