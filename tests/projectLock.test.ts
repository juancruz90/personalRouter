import { describe, expect, it } from 'vitest';
import {
  assertProjectWritable,
  isProjectReadOnly,
  parseReadOnlyProjects,
  projectAccess,
  ProjectWriteLockedError,
} from '../src/projectLock';

describe('project lock', () => {
  it('parses read-only project list from csv', () => {
    const parsed = parseReadOnlyProjects('reel, analytics ,  provider ');

    expect(parsed.has('reel')).toBe(true);
    expect(parsed.has('analytics')).toBe(true);
    expect(parsed.has('provider')).toBe(true);
  });

  it('marks reel as read-only by default', () => {
    expect(isProjectReadOnly('reel')).toBe(true);
    expect(isProjectReadOnly('personal-provider')).toBe(false);
  });

  it('returns project access metadata', () => {
    expect(projectAccess('reel')).toEqual({
      project: 'reel',
      mode: 'read-only',
      writable: false,
    });

    expect(projectAccess('personal-provider')).toEqual({
      project: 'personal-provider',
      mode: 'read-write',
      writable: true,
    });
  });

  it('throws ProjectWriteLockedError when writing to locked project', () => {
    expect(() => assertProjectWritable('reel')).toThrow(ProjectWriteLockedError);
    expect(() => assertProjectWritable('personal-provider')).not.toThrow();
  });
});
