// Counts D1 round trips. A request is one call to first, run, all, raw, batch or exec.
// statements counts every statement those requests carry, so a batch of 3 is 3.
// batch() needs the real statements, so a WeakMap unwraps the ones it is handed.
export function countingD1(db: D1Database): {
  db: D1Database;
  counts(): { requests: number; statements: number };
  reset(): void;
} {
  let requests = 0;
  let statements = 0;
  const real = new WeakMap<object, D1PreparedStatement>();

  const once = <T>(work: () => T): T => {
    requests += 1;
    statements += 1;
    return work();
  };

  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: (...args: [string?]) =>
        once(() => statement.first(...(args as [string]))),
      run: () => once(() => statement.run()),
      all: () => once(() => statement.all()),
      raw: (...args: unknown[]) =>
        once(() => statement.raw(...(args as [{ columnNames: true }]))),
    };
    real.set(wrapped, statement);
    return wrapped as unknown as D1PreparedStatement;
  };

  const unwrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const found = real.get(statement);
    if (found === undefined)
      throw new Error("batch got an unwrapped statement");
    return found;
  };

  const counted = {
    prepare: (query: string) => wrap(db.prepare(query)),
    batch: (list: D1PreparedStatement[]) => {
      requests += 1;
      statements += list.length;
      return db.batch(list.map(unwrap));
    },
    exec: (query: string) => once(() => db.exec(query)),
  };

  return {
    db: counted as unknown as D1Database,
    counts: () => ({ requests, statements }),
    reset: () => {
      requests = 0;
      statements = 0;
    },
  };
}
