import { isRecord } from "../lib/record";
import { CONFIG_VAR, isHttpsUrl, parseJsonText } from "./text";
import type { AppConfig } from "./types";

const APP_FIELDS = new Set(["store", "id", "name", "consoleUrl"]);

export function parseApps(
  value: unknown,
  errors: string[],
): AppConfig[] | null {
  const before = errors.length;
  if (value === undefined || value === "") {
    errors.push(`\`APPS\` is missing. ${CONFIG_VAR}`);
    return null;
  }

  const parsed = typeof value === "string" ? parseJsonText(value) : value;
  if (typeof value === "string" && parsed === undefined) {
    errors.push(`\`APPS\` is not valid JSON. ${CONFIG_VAR}`);
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    errors.push(`\`APPS\` must be a non-empty array. ${CONFIG_VAR}`);
    return null;
  }

  const apps: AppConfig[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < parsed.length; index++) {
    const app = parseApp(parsed[index], index, errors);
    if (app === null) continue;
    if (seen.has(app.id)) {
      errors.push(
        `\`APPS[${index}].id\` duplicates \`${app.id}\`. ${CONFIG_VAR}`,
      );
      continue;
    }
    seen.add(app.id);
    apps.push(app);
  }

  return errors.length === before ? apps : null;
}

function parseApp(
  value: unknown,
  index: number,
  errors: string[],
): AppConfig | null {
  if (!isRecord(value)) {
    errors.push(`\`APPS[${index}]\` must be an object. ${CONFIG_VAR}`);
    return null;
  }

  let ok = true;
  const unknown = Object.keys(value)
    .filter((key) => !APP_FIELDS.has(key))
    .sort();
  for (const field of unknown) {
    errors.push(
      `\`APPS[${index}]\` has unknown field \`${field}\`. Remove it. ${CONFIG_VAR}`,
    );
    ok = false;
  }

  if (value.store !== "play") {
    errors.push(`\`APPS[${index}].store\` must be one of: play. ${CONFIG_VAR}`);
    ok = false;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (id === "") {
    errors.push(`\`APPS[${index}].id\` is missing. ${CONFIG_VAR}`);
    ok = false;
  }

  let name = id;
  if (value.name !== undefined) {
    if (typeof value.name !== "string" || value.name.trim() === "") {
      errors.push(
        `\`APPS[${index}].name\` must be a non-empty string. ${CONFIG_VAR}`,
      );
      ok = false;
    } else {
      name = value.name.trim();
    }
  }

  let consoleUrl: string | null = null;
  if (value.consoleUrl !== undefined && value.consoleUrl !== null) {
    if (typeof value.consoleUrl !== "string" || !isHttpsUrl(value.consoleUrl)) {
      errors.push(
        `\`APPS[${index}].consoleUrl\` must be an https URL. ${CONFIG_VAR}`,
      );
      ok = false;
    } else {
      consoleUrl = value.consoleUrl;
    }
  }

  if (!ok) return null;
  return { store: "play", id, name, consoleUrl };
}
