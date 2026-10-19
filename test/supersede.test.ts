import { describe, expect, it } from "vitest";
import { supersedeComponents } from "../src/notifiers/discord/supersede";

const LINE = "Updated, see the newer message.";

describe("supersedeComponents", () => {
  it("drops the action row and appends the pointer", () => {
    const result = supersedeComponents(
      [
        {
          type: 17,
          components: [
            { type: 10, content: "keep-me" },
            { type: 1, components: [{ type: 2, label: "Reply" }] },
          ],
        },
      ],
      LINE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.components);
    expect(serialized).not.toContain('"type":1,');
    expect(serialized).toContain("keep-me");
    expect(serialized).toContain(LINE);
  });

  it("rejects a message with no container", () => {
    expect(supersedeComponents([{ type: 10, content: "loose" }], LINE)).toEqual(
      { ok: false },
    );
    expect(supersedeComponents("nope", LINE)).toEqual({ ok: false });
  });
});
