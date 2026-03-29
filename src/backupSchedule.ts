export interface DailySchedule {
  hour: number;
  minute: number;
}

export function parseDailySchedule(value: string | undefined): DailySchedule | null {
  const raw = (value || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return { hour, minute };
}

export function millisecondsUntilNextDailyRun(
  schedule: DailySchedule,
  now = new Date(),
): number {
  const target = new Date(now);
  target.setHours(schedule.hour, schedule.minute, 0, 0);

  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return Math.max(0, target.getTime() - now.getTime());
}
