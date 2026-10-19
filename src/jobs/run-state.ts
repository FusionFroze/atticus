// The state rows read once at the start of a run, kept in step with this run's
// own writes. The lease means no other cron writes them meanwhile, and
// interactions never touch state.
export type RunState = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  keys(prefix: string): string[];
};

export function createRunState(rows: ReadonlyMap<string, string>): RunState {
  const values = new Map(rows);
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
    delete: (key) => {
      values.delete(key);
    },
    keys: (prefix) =>
      [...values.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
}
