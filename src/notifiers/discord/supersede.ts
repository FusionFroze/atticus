import type {
  APIMessageComponent,
  APITextDisplayComponent,
  ComponentType,
} from "discord-api-types/v10";
import { isRecord } from "../../lib/record";
import { TEXT_LIMIT, truncate } from "./parts";

const TEXT_DISPLAY = 10 as ComponentType.TextDisplay;
const ACTION_ROW = 1;
const CONTAINER = 17;

// The previous Discord message is the only copy of the old wording. Drop its
// buttons and append the pointer. An unrecognised shape is left for the caller.
export function supersedeComponents(
  components: unknown,
  line: string,
): { ok: true; components: APIMessageComponent[] } | { ok: false } {
  if (!Array.isArray(components)) return { ok: false };
  let found = false;
  const next = components.map((component) => {
    if (!isRecord(component) || component.type !== CONTAINER) return component;
    if (!Array.isArray(component.components)) return component;
    found = true;
    const children = component.components.filter(
      (child) => !isRecord(child) || child.type !== ACTION_ROW,
    );
    children.push(textDisplay(line));
    return { ...component, components: children };
  });
  if (!found) return { ok: false };
  return { ok: true, components: next as APIMessageComponent[] };
}

function textDisplay(content: string): APITextDisplayComponent {
  return { type: TEXT_DISPLAY, content: truncate(content, TEXT_LIMIT) };
}
