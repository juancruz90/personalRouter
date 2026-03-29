const REDACTED = '[REDACTED]';

const SENSITIVE_KEY = /(token|authorization|api[-_]?key|secret|password|cookie|session)/i;

function redactTokenLikeSegments(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|rk)-[A-Za-z0-9._\-]+/g, '[REDACTED]')
    .replace(
      /(access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
      (_match, key: string) => `${key}=[REDACTED]`,
    );
}

export function sanitizeForLog<T = unknown>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return redactTokenLikeSegments(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item)) as T;
  }

  if (typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(input)) {
      if (SENSITIVE_KEY.test(key)) {
        output[key] = REDACTED;
        continue;
      }

      output[key] = sanitizeForLog(val);
    }

    return output as T;
  }

  return value;
}
