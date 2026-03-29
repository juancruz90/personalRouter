import { describe, expect, it } from 'vitest';
import { millisecondsUntilNextDailyRun, parseDailySchedule } from '../src/backupSchedule';

describe('backupSchedule', () => {
  it('parses HH:MM schedule and rejects invalid values', () => {
    expect(parseDailySchedule('03:00')).toEqual({ hour: 3, minute: 0 });
    expect(parseDailySchedule('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseDailySchedule('24:00')).toBeNull();
    expect(parseDailySchedule('03:60')).toBeNull();
    expect(parseDailySchedule('abc')).toBeNull();
  });

  it('computes milliseconds until next run for same day and next day rollover', () => {
    const sameDay = millisecondsUntilNextDailyRun(
      { hour: 3, minute: 0 },
      new Date(2026, 2, 25, 1, 0, 0, 0),
    );

    expect(sameDay).toBe(2 * 60 * 60_000);

    const nextDay = millisecondsUntilNextDailyRun(
      { hour: 3, minute: 0 },
      new Date(2026, 2, 25, 4, 0, 0, 0),
    );

    expect(nextDay).toBe(23 * 60 * 60_000);
  });
});
