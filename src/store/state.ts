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

export async function deleteState(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM state WHERE key = ?").bind(key).run();
}

export async function setState(
  db: D1Database,
  key: string,
  value: string,
  nowSeconds: number,
): Promise<void> {
  await setStateStatement(db, key, value, nowSeconds).run();
}

export function setStateStatement(
  db: D1Database,
  key: string,
  value: string,
  nowSeconds: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(key, value, nowSeconds);
}
