import { describe, expect, it } from 'vitest';
import { sanitizeForLog } from '../src/logSanitizer';

describe('sanitizeForLog', () => {
  it('redacts sensitive keys recursively', () => {
    const payload = {
      access_token: 'abc123',
      nested: {
        authorization: 'Bearer sk-secret',
        ok: 'value',
      },
    };

    const sanitized = sanitizeForLog(payload);

    expect(sanitized.access_token).toBe('[REDACTED]');
    expect(sanitized.nested.authorization).toBe('[REDACTED]');
    expect(sanitized.nested.ok).toBe('value');
  });

  it('redacts token-like segments inside free text', () => {
    const text = 'Authorization: Bearer sk-abcdef access_token=xyz';
    const sanitized = sanitizeForLog(text);

    expect(sanitized).not.toContain('sk-abcdef');
    expect(sanitized).toContain('Authorization=[REDACTED]');
    expect(sanitized).toContain('access_token=[REDACTED]');
  });

  it('redacts sensitive keys inside arrays of objects', () => {
    const payload = [
      { apiKey: 'k-1', label: 'a' },
      { token: 'k-2', label: 'b' },
    ];

    const sanitized = sanitizeForLog(payload);

    expect(sanitized[0].apiKey).toBe('[REDACTED]');
    expect(sanitized[1].token).toBe('[REDACTED]');
    expect(sanitized[0].label).toBe('a');
  });

  it('does not mutate primitive values', () => {
    expect(sanitizeForLog(42)).toBe(42);
    expect(sanitizeForLog(true)).toBe(true);
    expect(sanitizeForLog(null)).toBeNull();
  });
});
