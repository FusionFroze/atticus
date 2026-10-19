import { describe, expect, it } from "vitest";
import { replyWouldNotify } from "../src/core/reply";

const MODIFIED_AT = 1_700_000_000;

describe("replyWouldNotify", () => {
  it("notifies when there is no reply", () => {
    expect(
      replyWouldNotify({
        replyText: null,
        replyModifiedAt: null,
        repliedAt: null,
        modifiedAt: MODIFIED_AT,
      }),
    ).toBe(true);
  });

  it("does not promise a notification when the reply has no timestamp", () => {
    expect(
      replyWouldNotify({
        replyText: "Thanks",
        replyModifiedAt: null,
        repliedAt: null,
        modifiedAt: MODIFIED_AT,
      }),
    ).toBe(false);
  });

  it("notifies when every reply timestamp is older than the review", () => {
    expect(
      replyWouldNotify({
        replyText: "Thanks",
        replyModifiedAt: MODIFIED_AT - 5,
        repliedAt: MODIFIED_AT - 4,
        modifiedAt: MODIFIED_AT,
      }),
    ).toBe(true);
  });

  it("stays an edit when either timestamp is current", () => {
    expect(
      replyWouldNotify({
        replyText: "Thanks",
        replyModifiedAt: MODIFIED_AT,
        repliedAt: MODIFIED_AT - 5,
        modifiedAt: MODIFIED_AT,
      }),
    ).toBe(false);
    expect(
      replyWouldNotify({
        replyText: "Thanks",
        replyModifiedAt: MODIFIED_AT - 5,
        repliedAt: MODIFIED_AT + 1,
        modifiedAt: MODIFIED_AT,
      }),
    ).toBe(false);
  });
});
