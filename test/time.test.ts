import { describe, expect, it } from "vitest";
import { digestTiming, lastScheduledAt, zonedParts } from "../src/core/time";

const MONDAY = 1;
const SUNDAY = 0;
const DAY_MS = 24 * 60 * 60 * 1000;

describe("zonedParts", () => {
  it("reads Kolkata midnight as hour 0 on that local date", () => {
    expect(
      zonedParts(Date.parse("2026-10-18T18:30:00Z"), "Asia/Kolkata"),
    ).toMatchObject({
      year: 2026,
      month: 10,
      day: 19,
      hour: 0,
      minute: 0,
      weekday: MONDAY,
    });
  });
});

describe("lastScheduledAt", () => {
  it("hits Monday 09:00 in Kolkata and steps back before that hour", () => {
    expect(slot("2026-10-19T03:30:00Z", "Asia/Kolkata", MONDAY, 9)).toEqual({
      instantMs: Date.parse("2026-10-19T03:30:00Z"),
      localDate: "2026-10-19",
    });
    expect(slot("2026-10-19T03:29:00Z", "Asia/Kolkata", MONDAY, 9)).toEqual({
      instantMs: Date.parse("2026-10-12T03:30:00Z"),
      localDate: "2026-10-12",
    });
  });

  it("keeps Sunday night and Monday midnight on the previous Kolkata week", () => {
    const previous = {
      instantMs: Date.parse("2026-10-12T03:30:00Z"),
      localDate: "2026-10-12",
    };
    expect(slot("2026-10-18T18:29:00Z", "Asia/Kolkata", MONDAY, 9)).toEqual(
      previous,
    );
    expect(slot("2026-10-18T18:30:00Z", "Asia/Kolkata", MONDAY, 9)).toEqual(
      previous,
    );
  });

  it("follows New York across the spring change, including the missing hour", () => {
    expect(slot("2026-03-09T13:00:00Z", "America/New_York", MONDAY, 9)).toEqual(
      {
        instantMs: Date.parse("2026-03-09T13:00:00Z"),
        localDate: "2026-03-09",
      },
    );
    expect(slot("2026-03-09T12:59:00Z", "America/New_York", MONDAY, 9)).toEqual(
      {
        instantMs: Date.parse("2026-03-02T14:00:00Z"),
        localDate: "2026-03-02",
      },
    );
    const gap = slot("2026-03-08T07:30:00Z", "America/New_York", SUNDAY, 2);
    expect(gap).toEqual({
      instantMs: Date.parse("2026-03-01T07:00:00Z"),
      localDate: "2026-03-01",
    });
    expect(zonedParts(gap.instantMs, "America/New_York").hour).toBe(2);
  });

  it("picks the later New York fall overlap that is still in the past", () => {
    expect(slot("2026-11-01T05:30:00Z", "America/New_York", SUNDAY, 1)).toEqual(
      {
        instantMs: Date.parse("2026-11-01T05:00:00Z"),
        localDate: "2026-11-01",
      },
    );
    expect(slot("2026-11-01T06:00:00Z", "America/New_York", SUNDAY, 1)).toEqual(
      {
        instantMs: Date.parse("2026-11-01T06:00:00Z"),
        localDate: "2026-11-01",
      },
    );
    expect(slot("2026-11-02T14:00:00Z", "America/New_York", MONDAY, 9)).toEqual(
      {
        instantMs: Date.parse("2026-11-02T14:00:00Z"),
        localDate: "2026-11-02",
      },
    );
    expect(slot("2026-11-02T13:59:00Z", "America/New_York", MONDAY, 9)).toEqual(
      {
        instantMs: Date.parse("2026-10-26T13:00:00Z"),
        localDate: "2026-10-26",
      },
    );
  });

  it("follows London across the spring change, including the missing hour", () => {
    expect(slot("2026-03-30T08:00:00Z", "Europe/London", MONDAY, 9)).toEqual({
      instantMs: Date.parse("2026-03-30T08:00:00Z"),
      localDate: "2026-03-30",
    });
    expect(slot("2026-03-30T07:59:00Z", "Europe/London", MONDAY, 9)).toEqual({
      instantMs: Date.parse("2026-03-23T09:00:00Z"),
      localDate: "2026-03-23",
    });
    expect(slot("2026-03-29T01:30:00Z", "Europe/London", SUNDAY, 1)).toEqual({
      instantMs: Date.parse("2026-03-22T01:00:00Z"),
      localDate: "2026-03-22",
    });
  });

  it("picks the later London fall overlap that is still in the past", () => {
    expect(slot("2026-10-25T00:30:00Z", "Europe/London", SUNDAY, 1)).toEqual({
      instantMs: Date.parse("2026-10-25T00:00:00Z"),
      localDate: "2026-10-25",
    });
    expect(slot("2026-10-25T01:00:00Z", "Europe/London", SUNDAY, 1)).toEqual({
      instantMs: Date.parse("2026-10-25T01:00:00Z"),
      localDate: "2026-10-25",
    });
    expect(slot("2026-10-26T09:00:00Z", "Europe/London", MONDAY, 9)).toEqual({
      instantMs: Date.parse("2026-10-26T09:00:00Z"),
      localDate: "2026-10-26",
    });
    expect(slot("2026-10-26T08:59:00Z", "Europe/London", MONDAY, 9)).toEqual({
      instantMs: Date.parse("2026-10-19T08:00:00Z"),
      localDate: "2026-10-19",
    });
  });
});

describe("digestTiming", () => {
  const scheduled = {
    instantMs: Date.parse("2026-10-19T03:30:00Z"),
    localDate: "2026-10-19",
  };

  it("is due on the hour and 23 hours 59 minutes later", () => {
    expect(digestTiming(scheduled.instantMs, scheduled, null)).toBe("due");
    expect(
      digestTiming(scheduled.instantMs + DAY_MS - 60_000, scheduled, null),
    ).toBe("due");
  });

  it("is late at exactly 24 hours", () => {
    expect(digestTiming(scheduled.instantMs + DAY_MS, scheduled, null)).toBe(
      "late",
    );
  });

  it("is done when digest_last is that local date", () => {
    expect(digestTiming(scheduled.instantMs, scheduled, "2026-10-19")).toBe(
      "done",
    );
    expect(digestTiming(scheduled.instantMs, scheduled, "2026-10-12")).toBe(
      "due",
    );
  });
});

function slot(
  iso: string,
  timeZone: string,
  day: 0 | 1,
  hour: number,
): { instantMs: number; localDate: string } {
  return lastScheduledAt(Date.parse(iso), timeZone, day, hour);
}
