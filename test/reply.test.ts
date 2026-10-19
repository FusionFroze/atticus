import { describe, expect, it } from "vitest";
import { validateReplyText } from "../src/jobs/reply";

describe("validateReplyText", () => {
  it("trims and accepts 1 to 350 code points", () => {
    expect(validateReplyText("  hello  ")).toEqual({
      ok: true,
      text: "hello",
    });
    expect(validateReplyText("a".repeat(350))).toEqual({
      ok: true,
      text: "a".repeat(350),
    });
    expect(validateReplyText("😀".repeat(350))).toEqual({
      ok: true,
      text: "😀".repeat(350),
    });
  });

  it("rejects empty and over-long text", () => {
    expect(validateReplyText("   \n")).toEqual({ ok: false, reason: "empty" });
    expect(validateReplyText("a".repeat(351))).toEqual({
      ok: false,
      reason: "too_long",
    });
    expect(validateReplyText(`😀${"a".repeat(350)}`)).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
});
