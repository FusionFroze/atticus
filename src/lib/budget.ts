// 45 of the 50 external subrequests the free plan allows, leaving 5 unused (V23).
export const EXTERNAL_CALL_LIMIT = 45;

// The sender stops after this much wall time. The cron's own wall limit is 15 minutes.
export const SENDER_WALL_MS = 60_000;

export type Budget = {
  readonly limit: number;
  remaining(): number;
  take(): boolean;
  readonly deadline: number;
};

export function createBudget(
  nowMs: number,
  limit = EXTERNAL_CALL_LIMIT,
  wallMs = SENDER_WALL_MS,
): Budget {
  let left = limit;
  return {
    limit,
    remaining: () => left,
    take: () => {
      if (left <= 0) return false;
      left -= 1;
      return true;
    },
    deadline: nowMs + wallMs,
  };
}
