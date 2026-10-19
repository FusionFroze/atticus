import { describe, expect, it } from "vitest";
import { type DigestRow, digestStats, WEEK_SECONDS } from "../src/core/digest";

const END = 1_700_000_000;
const THIS_START = END - WEEK_SECONDS;
const PREVIOUS_START = END - 2 * WEEK_SECONDS;

describe("digestStats", () => {
  it("is quiet when both weeks are empty", () => {
    expect(digestStats([], END)).toEqual({
      newCount: 0,
      editedCount: 0,
      averageRating: null,
      previousAverage: null,
      averageChange: null,
      distribution: [0, 0, 0, 0, 0],
      repliedCount: 0,
      replyRate: null,
      medianReplySeconds: null,
      versions: [],
      lowestUnanswered: [],
      quiet: true,
    });
  });

  it("keeps a previous week when this week is empty", () => {
    const stats = digestStats(
      [row({ id: 1, rating: 4, firstSeenAt: PREVIOUS_START })],
      END,
    );
    expect(stats.newCount).toBe(0);
    expect(stats.editedCount).toBe(0);
    expect(stats.previousAverage).toBe(4);
    expect(stats.averageRating).toBeNull();
    expect(stats.averageChange).toBeNull();
    expect(stats.quiet).toBe(true);
  });

  it("summarises one new review", () => {
    const only = row({
      id: 7,
      rating: 5,
      title: "Calm",
      appVersionName: "1.4.2",
      firstSeenAt: THIS_START,
    });
    const stats = digestStats([only], END);
    expect(stats.newCount).toBe(1);
    expect(stats.editedCount).toBe(0);
    expect(stats.averageRating).toBe(5);
    expect(stats.averageChange).toBeNull();
    expect(stats.distribution).toEqual([0, 0, 0, 0, 1]);
    expect(stats.repliedCount).toBe(0);
    expect(stats.replyRate).toBe(0);
    expect(stats.medianReplySeconds).toBeNull();
    expect(stats.versions).toEqual([{ name: "1.4.2", count: 1 }]);
    expect(stats.lowestUnanswered).toEqual([only]);
    expect(stats.quiet).toBe(false);
  });

  it("counts a same-week edit as new only, and an older edit on its own", () => {
    const stats = digestStats(
      [
        row({
          id: 1,
          firstSeenAt: THIS_START + 10,
          modifiedAt: THIS_START + 20,
        }),
        row({
          id: 2,
          rating: 2,
          firstSeenAt: PREVIOUS_START - 50,
          modifiedAt: THIS_START,
        }),
      ],
      END,
    );
    expect(stats.newCount).toBe(1);
    expect(stats.editedCount).toBe(1);
    expect(stats.averageRating).toBe(5);
    expect(stats.quiet).toBe(false);
  });

  it("averages this week against the previous week", () => {
    const stats = digestStats(
      [
        row({ id: 1, rating: 1, firstSeenAt: THIS_START }),
        row({ id: 2, rating: 2, firstSeenAt: THIS_START + 1 }),
        row({ id: 3, rating: 5, firstSeenAt: THIS_START + 2 }),
        row({ id: 4, rating: 5, firstSeenAt: THIS_START + 3 }),
        row({ id: 5, rating: 2, firstSeenAt: PREVIOUS_START }),
        row({ id: 6, rating: 4, firstSeenAt: PREVIOUS_START + 1 }),
      ],
      END,
    );
    expect(stats.averageRating).toBe(3.25);
    expect(stats.previousAverage).toBe(3);
    expect(stats.averageChange).toBe(0.25);
    expect(stats.distribution).toEqual([1, 1, 0, 0, 2]);
  });

  it("counts bot and external replies, and medians bot delays only", () => {
    const stats = digestStats(
      [
        row({
          id: 1,
          firstSeenAt: THIS_START,
          repliedVia: "bot",
          repliedAt: THIS_START + 100,
        }),
        row({
          id: 2,
          firstSeenAt: THIS_START + 1,
          repliedVia: "external",
          repliedAt: THIS_START + 50,
        }),
        row({ id: 3, firstSeenAt: THIS_START + 2 }),
        row({
          id: 4,
          firstSeenAt: THIS_START + 3,
          repliedVia: "bot",
          repliedAt: null,
        }),
        row({
          id: 5,
          firstSeenAt: THIS_START + 4,
          repliedVia: "bot",
          repliedAt: THIS_START + 4 - 5,
        }),
        row({
          id: 6,
          firstSeenAt: THIS_START + 5,
          repliedVia: "bot",
          repliedAt: THIS_START + 5 + 300,
        }),
      ],
      END,
    );
    expect(stats.repliedCount).toBe(5);
    expect(stats.replyRate).toBe(5 / 6);
    expect(stats.medianReplySeconds).toBe(200);
  });

  it("uses the single bot delay as the median", () => {
    const stats = digestStats(
      [
        row({
          id: 1,
          firstSeenAt: THIS_START,
          repliedVia: "bot",
          repliedAt: THIS_START + 45,
        }),
      ],
      END,
    );
    expect(stats.medianReplySeconds).toBe(45);
    expect(stats.replyRate).toBe(1);
  });

  it("orders tied versions by name and labels a blank version Unknown", () => {
    const stats = digestStats(
      [
        row({ id: 1, appVersionName: "2.0", firstSeenAt: THIS_START }),
        row({ id: 2, appVersionName: "2.0", firstSeenAt: THIS_START }),
        row({ id: 3, appVersionName: "1.0", firstSeenAt: THIS_START }),
        row({ id: 4, appVersionName: "1.0", firstSeenAt: THIS_START }),
        row({ id: 5, appVersionName: null, firstSeenAt: THIS_START }),
        row({ id: 6, appVersionName: "  ", firstSeenAt: THIS_START }),
      ],
      END,
    );
    expect(stats.versions).toEqual([
      { name: "1.0", count: 2 },
      { name: "2.0", count: 2 },
      { name: "Unknown", count: 2 },
    ]);
  });

  it("keeps the three oldest 1-star reviews when four tie", () => {
    const stats = digestStats(
      [1, 2, 3, 4].map((id) =>
        row({ id, rating: 1, firstSeenAt: THIS_START + id }),
      ),
      END,
    );
    expect(stats.lowestUnanswered.map((row) => row.id)).toEqual([1, 2, 3]);
  });

  it("skips a replied 1-star review for an unanswered 2-star review", () => {
    const unanswered = row({
      id: 2,
      rating: 2,
      firstSeenAt: THIS_START,
    });
    const stats = digestStats(
      [
        row({
          id: 1,
          rating: 1,
          firstSeenAt: THIS_START,
          repliedVia: "bot",
          repliedAt: THIS_START + 1,
        }),
        unanswered,
      ],
      END,
    );
    expect(stats.lowestUnanswered).toEqual([unanswered]);
  });

  it("treats the window bounds as half-open", () => {
    const stats = digestStats(
      [
        row({ id: 1, rating: 5, firstSeenAt: THIS_START }),
        row({ id: 2, rating: 1, firstSeenAt: END }),
        row({ id: 3, rating: 3, firstSeenAt: THIS_START - 1 }),
        row({
          id: 4,
          firstSeenAt: PREVIOUS_START - 10,
          modifiedAt: END,
        }),
        row({
          id: 5,
          rating: 4,
          firstSeenAt: PREVIOUS_START - 10,
          modifiedAt: THIS_START,
        }),
      ],
      END,
    );
    expect(stats.newCount).toBe(1);
    expect(stats.previousAverage).toBe(3);
    expect(stats.editedCount).toBe(1);
    expect(stats.averageRating).toBe(5);
  });
});

function row(overrides: Partial<DigestRow> & Pick<DigestRow, "id">): DigestRow {
  const firstSeenAt = overrides.firstSeenAt ?? THIS_START;
  return {
    rating: 5,
    title: null,
    appVersionName: "1.0",
    modifiedAt: overrides.modifiedAt ?? firstSeenAt,
    firstSeenAt,
    repliedVia: null,
    repliedAt: null,
    ...overrides,
  };
}
