export const WEEK_SECONDS = 7 * 24 * 60 * 60;

export type DigestRow = {
  id: number;
  rating: 1 | 2 | 3 | 4 | 5;
  title: string | null;
  appVersionName: string | null;
  modifiedAt: number;
  firstSeenAt: number;
  repliedVia: "bot" | "external" | null;
  repliedAt: number | null;
};

export type DigestStats = {
  newCount: number;
  editedCount: number;
  averageRating: number | null;
  previousAverage: number | null;
  averageChange: number | null;
  distribution: [number, number, number, number, number];
  repliedCount: number;
  replyRate: number | null;
  medianReplySeconds: number | null;
  versions: { name: string; count: number }[];
  lowestUnanswered: DigestRow[];
  quiet: boolean;
};

export function digestStats(
  rows: readonly DigestRow[],
  windowEnd: number,
): DigestStats {
  const thisStart = windowEnd - WEEK_SECONDS;
  const previousStart = windowEnd - 2 * WEEK_SECONDS;
  const arrived = rows.filter((row) =>
    inWindow(row.firstSeenAt, thisStart, windowEnd),
  );
  const previous = rows.filter((row) =>
    inWindow(row.firstSeenAt, previousStart, thisStart),
  );
  const edited = rows.filter(
    (row) =>
      row.firstSeenAt < thisStart &&
      inWindow(row.modifiedAt, thisStart, windowEnd),
  );
  const averageRating = mean(arrived.map((row) => row.rating));
  const previousAverage = mean(previous.map((row) => row.rating));
  return {
    newCount: arrived.length,
    editedCount: edited.length,
    averageRating,
    previousAverage,
    averageChange:
      averageRating === null || previousAverage === null
        ? null
        : averageRating - previousAverage,
    distribution: distribution(arrived),
    repliedCount: arrived.filter((row) => row.repliedVia !== null).length,
    replyRate:
      arrived.length === 0
        ? null
        : arrived.filter((row) => row.repliedVia !== null).length /
          arrived.length,
    medianReplySeconds: median(replyDurations(arrived)),
    versions: versionCounts(arrived),
    lowestUnanswered: lowestUnanswered(arrived),
    quiet: arrived.length === 0 && edited.length === 0,
  };
}

function inWindow(instant: number, start: number, end: number): boolean {
  return instant >= start && instant < end;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function replyDurations(rows: readonly DigestRow[]): number[] {
  const durations: number[] = [];
  for (const row of rows) {
    if (row.repliedVia !== "bot" || row.repliedAt === null) continue;
    const duration = row.repliedAt - row.firstSeenAt;
    if (duration < 0) continue;
    durations.push(duration);
  }
  return durations;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  if (lower === undefined) return null;
  return (lower + upper) / 2;
}

function distribution(
  rows: readonly DigestRow[],
): [number, number, number, number, number] {
  const counts: Record<DigestRow["rating"], number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  };
  for (const row of rows) counts[row.rating] += 1;
  return [counts[1], counts[2], counts[3], counts[4], counts[5]];
}

function versionCounts(
  rows: readonly DigestRow[],
): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = versionName(row.appVersionName);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    );
}

function versionName(name: string | null): string {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" ? "Unknown" : trimmed;
}

function lowestUnanswered(rows: readonly DigestRow[]): DigestRow[] {
  return rows
    .filter((row) => row.repliedVia === null)
    .sort(
      (left, right) =>
        left.rating - right.rating ||
        left.firstSeenAt - right.firstSeenAt ||
        left.id - right.id,
    )
    .slice(0, 3);
}
