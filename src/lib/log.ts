export type LogValue = string | number | boolean | null | readonly LogValue[];

// One JSON object per line. Callers pass ids and statuses, never review text, names, replies or secrets.
export function log(
  event: string,
  fields: Record<string, LogValue> = {},
): void {
  console.log(JSON.stringify({ event, ...fields }));
}
