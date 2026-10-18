const LEASE_KEY = "lease";
// The cron interval is 15 minutes. The lease expires before the next run can start.
const LEASE_SECONDS = 10 * 60;

export async function getState(
  db: D1Database,
  key: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(
  db: D1Database,
  key: string,
  value: string,
  nowSeconds: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(key, value, nowSeconds)
    .run();
}

// Value is `{expiry}:{holder}`. The upsert lands only when the row is missing or expired.
export async function takeLease(
  db: D1Database,
  nowSeconds: number,
  holder: string,
): Promise<boolean> {
  const value = `${nowSeconds + LEASE_SECONDS}:${holder}`;
  const result = await db
    .prepare(
      `INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       WHERE CAST(substr(state.value, 1, instr(state.value, ':') - 1) AS INTEGER) <= ?`,
    )
    .bind(LEASE_KEY, value, nowSeconds, nowSeconds)
    .run();
  return result.meta.changes === 1;
}

// Deletes the value read for this holder, so a lease taken in between is left alone.
export async function releaseLease(
  db: D1Database,
  holder: string,
): Promise<void> {
  const current = await getState(db, LEASE_KEY);
  if (current === null) return;
  const separator = current.indexOf(":");
  if (separator === -1 || current.slice(separator + 1) !== holder) return;
  await db
    .prepare("DELETE FROM state WHERE key = ? AND value = ?")
    .bind(LEASE_KEY, current)
    .run();
}
