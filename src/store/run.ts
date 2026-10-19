import { pruneStatement } from "./outbox";
import { setStateStatement } from "./state";

const LEASE_KEY = "lease";
// The cron interval is 15 minutes. The lease expires before the next run can start.
const LEASE_SECONDS = 10 * 60;
const LAST_POLL_AT = "last_poll_at";

export type RunStart = { lease: string; state: Map<string, string> };

// One batch: the lease upsert, then every state row. The batch is one transaction,
// so the rows include the lease just written. null means another run holds it.
// The lease value is `{expiry}:{holder}`. The upsert lands only when the row is
// missing or expired.
export async function startRun(
  db: D1Database,
  nowSeconds: number,
  holder: string,
): Promise<RunStart | null> {
  const lease = `${nowSeconds + LEASE_SECONDS}:${holder}`;
  const [taken, rows] = await db.batch([
    db
      .prepare(
        `INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at
         WHERE CAST(substr(state.value, 1, instr(state.value, ':') - 1) AS INTEGER) <= ?`,
      )
      .bind(LEASE_KEY, lease, nowSeconds, nowSeconds),
    db.prepare("SELECT key, value FROM state"),
  ]);
  if (taken?.meta.changes !== 1) return null;
  return { lease, state: stateMap(rows) };
}

export async function readAllState(
  db: D1Database,
): Promise<Map<string, string>> {
  return stateMap(await db.prepare("SELECT key, value FROM state").all());
}

// One batch for a run that held the lease: last_poll_at, the prune, the release.
export async function finishRun(
  db: D1Database,
  input: { lease: string; nowSeconds: number },
): Promise<void> {
  await db.batch([
    setStateStatement(
      db,
      LAST_POLL_AT,
      String(input.nowSeconds),
      input.nowSeconds,
    ),
    pruneStatement(db, input.nowSeconds),
    releaseStatement(db, input.lease),
  ]);
}

// Deletes only the value this run wrote, so a lease taken since is left alone.
export async function releaseLease(
  db: D1Database,
  lease: string,
): Promise<void> {
  await releaseStatement(db, lease).run();
}

function releaseStatement(db: D1Database, lease: string): D1PreparedStatement {
  return db
    .prepare("DELETE FROM state WHERE key = ? AND value = ?")
    .bind(LEASE_KEY, lease);
}

function stateMap(rows: D1Result | undefined): Map<string, string> {
  const state = new Map<string, string>();
  for (const row of (rows?.results ?? []) as {
    key: string;
    value: string;
  }[]) {
    state.set(row.key, row.value);
  }
  return state;
}
