// Intl formats an instant into local parts. It does not parse a local time, so a
// daylight-saving overlap is resolved by probing nearby instants, and a missing
// hour uses the previous week's slot.

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
};

export type ScheduledMoment = {
  instantMs: number;
  localDate: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS: Record<string, ZonedParts["weekday"]> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function zonedParts(instantMs: number, timeZone: string): ZonedParts {
  return readParts(formatter(timeZone), instantMs);
}

export function lastScheduledAt(
  nowMs: number,
  timeZone: string,
  day: ZonedParts["weekday"],
  hour: number,
): ScheduledMoment {
  const format = formatter(timeZone);
  const now = readParts(format, nowMs);
  let daysBack = (now.weekday - day + 7) % 7;
  if (daysBack === 0 && now.hour < hour) daysBack = 7;
  let cursor = shiftDays(now, -daysBack);

  for (let attempt = 0; attempt < 3; attempt++) {
    const eligible = instantsAt(format, cursor, hour).filter(
      (instant) => instant <= nowMs,
    );
    const instantMs = eligible.reduce(
      (latest, instant) => Math.max(latest, instant),
      Number.NEGATIVE_INFINITY,
    );
    if (instantMs !== Number.NEGATIVE_INFINITY) {
      return {
        instantMs,
        localDate: dateStamp(readParts(format, instantMs)),
      };
    }
    cursor = shiftDays(cursor, -7);
  }
  throw new Error("no scheduled digest instant");
}

export function digestTiming(
  nowMs: number,
  scheduled: ScheduledMoment,
  digestLast: string | null,
): "due" | "done" | "late" {
  if (digestLast === scheduled.localDate) return "done";
  if (nowMs - scheduled.instantMs >= DAY_MS) return "late";
  return "due";
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function readParts(format: Intl.DateTimeFormat, instantMs: number): ZonedParts {
  const parts = format.formatToParts(new Date(instantMs));
  const weekday = WEEKDAYS[text(parts, "weekday")];
  if (weekday === undefined) throw new Error("unreadable local time");
  return {
    year: number(parts, "year"),
    month: number(parts, "month"),
    day: number(parts, "day"),
    hour: number(parts, "hour"),
    minute: number(parts, "minute"),
    second: number(parts, "second"),
    weekday,
  };
}

function text(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  const found = parts.find((part) => part.type === type);
  if (found === undefined || found.value === "") {
    throw new Error("unreadable local time");
  }
  return found.value;
}

function number(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  return Number(text(parts, type));
}

function shiftDays(
  parts: Pick<ZonedParts, "year" | "month" | "day">,
  days: number,
): Pick<ZonedParts, "year" | "month" | "day"> {
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function dateStamp(parts: ZonedParts): string {
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

function instantsAt(
  format: Intl.DateTimeFormat,
  date: Pick<ZonedParts, "year" | "month" | "day">,
  hour: number,
): number[] {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, 0, 0);
  const first = wall - offsetMs(format, wall);
  const found = new Set<number>();
  for (let step = -12; step <= 12; step++) {
    const instant = first + step * 15 * 60 * 1000;
    if (matches(format, instant, date, hour)) found.add(instant);
  }
  const second = wall - offsetMs(format, first);
  if (matches(format, second, date, hour)) found.add(second);
  return [...found];
}

function offsetMs(format: Intl.DateTimeFormat, instantMs: number): number {
  const parts = readParts(format, instantMs);
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) - instantMs
  );
}

function matches(
  format: Intl.DateTimeFormat,
  instantMs: number,
  date: Pick<ZonedParts, "year" | "month" | "day">,
  hour: number,
): boolean {
  const parts = readParts(format, instantMs);
  return (
    parts.year === date.year &&
    parts.month === date.month &&
    parts.day === date.day &&
    parts.hour === hour &&
    parts.minute === 0 &&
    parts.second === 0
  );
}
