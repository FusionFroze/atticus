import { describe, expect, it } from "vitest";
import type { StoredReview } from "../src/core/review";
import { createBudget } from "../src/lib/budget";
import { isRecord } from "../src/lib/record";
import type { DiscordMessageBody } from "../src/notifiers/discord/client";
import { createDiscordClient } from "../src/notifiers/discord/client";
import { truncate } from "../src/notifiers/discord/parts";
import {
  renderNotice,
  renderRepliedMessage,
  renderReview,
} from "../src/notifiers/discord/render";
import type { ReviewMessageInput } from "../src/notifiers/types";

const USER = "423456789012345678";
const ROLE = "523456789012345678";

describe("truncate", () => {
  it("keeps a string that is already within the limit", () => {
    expect(truncate("a".repeat(10), 10)).toBe("a".repeat(10));
  });

  it("cuts on a code point and marks the cut", () => {
    expect(truncate("a".repeat(11), 10)).toBe(`${"a".repeat(9)}…`);
    expect(truncate(`😀${"bc"}`, 2)).toBe("😀…");
    expect(truncate("😀", 1)).toBe("😀");
  });
});

describe("renderReview", () => {
  it("renders a 1 star and a 5 star title", () => {
    const low = renderReview(input(stored({ rating: 1, title: null })));
    const high = renderReview(input(stored({ rating: 5, title: "Loved it" })));
    expect(texts(low)[0]).toBe("★☆☆☆☆ 1/5");
    expect(texts(high)[0]).toBe("★★★★★ 5/5 · Loved it");
    expect(colorOf(low)).toBe(0xed4245);
    expect(colorOf(high)).toBe(0x57f287);
    expect(low.flags).toBe(32768);
    expect(low.content).toBeUndefined();
    expect(low.embeds).toBeUndefined();
  });

  it("uses amber for 3 stars", () => {
    expect(colorOf(renderReview(input(stored({ rating: 3 }))))).toBe(0xfee75c);
  });

  it("names a translation and falls back when the language is missing", () => {
    const translated = texts(
      renderReview(
        input(
          stored({ originalBody: "Bonjour", language: "fr", body: "Hello" }),
        ),
      ),
    ).join("\n");
    expect(translated).toContain("Translated from fr");
    expect(translated).toContain("Bonjour");

    const unnamed = texts(
      renderReview(input(stored({ originalBody: "Bonjour", language: null }))),
    ).join("\n");
    expect(unnamed).toContain("Translated");
    expect(unnamed).not.toContain("Translated from");
  });

  it("uses Anonymous and omits a missing device", () => {
    const joined = texts(
      renderReview(input(stored({ author: "  ", device: null }))),
    ).join("\n");
    expect(joined).toContain("Anonymous");
    expect(joined).not.toContain("Device");
    expect(joined).toContain("<t:1700000000:R>");
  });

  it("keeps a short body whole", () => {
    const body = texts(
      renderReview(input(stored({ body: "Calm and quiet." }))),
    );
    expect(body).toContain("Calm and quiet.");
    expect(body.some((text) => text.endsWith("…"))).toBe(false);
  });

  it("draws a stored reply from the row", () => {
    const external = renderReview(
      input(
        stored({
          replyText: "Thanks for playing",
          repliedVia: "external",
          replyModifiedAt: 1_700_000_100,
        }),
      ),
    );
    const bot = renderReview(
      input(
        stored({
          replyText: "Thanks for playing",
          repliedVia: "bot",
          repliedBy: USER,
          repliedAt: 1_700_000_100,
        }),
      ),
    );
    expect(texts(external).join("\n")).toContain(
      "**Your reply**\nThanks for playing",
    );
    expect(texts(external).join("\n")).toContain(
      "Replied in Play Console · <t:1700000100:R>",
    );
    expect(texts(bot).join("\n")).toContain(
      `Replied by <@${USER}> · <t:1700000100:R>`,
    );
    expect(bot.allowedMentions?.users).toBeUndefined();
    expect(buttons(external)[0]).toMatchObject({ label: "Edit reply" });
    expect(buttons(bot)[0]).toMatchObject({ label: "Edit reply" });
  });

  it("shows Review updated, and the rating change when the stars moved", () => {
    const changed = renderReview(
      input(
        stored({ rating: 4, previousRating: 2, body: "After" }),
        null,
        null,
        true,
      ),
    );
    const same = renderReview(
      input(stored({ rating: 4, previousRating: 4 }), null, null, true),
    );
    const hidden = renderReview(
      input(stored({ rating: 4, previousRating: 2 }), null, null, false),
    );
    expect(texts(changed).slice(0, 2)).toEqual(["Review updated", "★2 → ★4"]);
    expect(texts(same)[0]).toBe("Review updated");
    expect(texts(same).some((text) => text.includes("→"))).toBe(false);
    expect(texts(hidden).join("\n")).not.toContain("Review updated");
  });

  it("uses Reply when the stored reply is older than the review", () => {
    const message = renderReview(
      input(
        stored({
          replyText: "Thanks",
          repliedVia: "external",
          replyModifiedAt: 1_600_000_000,
          previousRating: 2,
          rating: 4,
        }),
        null,
        "https://play.google.com/console",
        true,
      ),
    );
    expect(texts(message).join("\n")).toContain("**Your reply**\nThanks");
    expect(buttons(message).map((button) => button.label)).toEqual([
      "Reply",
      "Open in Play Console",
    ]);
  });

  it("keeps the updated banner inside 4000 characters", () => {
    const message = renderReview(
      input(
        stored({
          rating: 5,
          previousRating: 1,
          title: "t".repeat(300),
          body: "b".repeat(5000),
          originalBody: "o".repeat(3000),
          language: "fr",
          device: "Pixel",
        }),
        null,
        null,
        true,
      ),
    );
    const joined = texts(message);
    const total = joined.reduce((sum, text) => sum + charLength(text), 0);
    expect(joined).toContain("Review updated");
    expect(joined).toContain("★1 → ★5");
    expect(total).toBeLessThanOrEqual(4000);
  });

  it("shows a published reply without letting it ping", () => {
    const message = renderRepliedMessage({
      review: stored({
        replyText: "Thanks for playing",
        repliedVia: "bot",
        repliedBy: USER,
        repliedAt: 1_700_000_100,
      }),
      appName: "Lune",
      consoleUrl: "https://example.com/console",
      note: {
        kind: "published",
        text: "Thanks for playing",
        userId: USER,
        at: 1_700_000_100,
      },
    });
    const joined = texts(message).join("\n");
    expect(joined).toContain("**Your reply**\nThanks for playing");
    expect(joined).toContain(`Replied by <@${USER}> · <t:1700000100:R>`);
    expect(buttons(message).map((button) => button.label)).toEqual([
      "Edit reply",
      "Open in Play Console",
    ]);
    expect(message.flags).toBe(32768);
    expect(message.content).toBeUndefined();
    expect(message.allowedMentions?.users).toBeUndefined();
    expect(message.allowedMentions?.parse).toBeUndefined();
  });

  it("marks a dry run and keeps the Reply button", () => {
    const message = renderRepliedMessage({
      review: stored(),
      appName: "Lune",
      consoleUrl: null,
      note: { kind: "dry_run", text: "Thanks for playing" },
    });
    const joined = texts(message).join("\n");
    expect(joined).toContain("**Your reply**\nThanks for playing");
    expect(joined).toContain("Dry run, not published.");
    expect(buttons(message)[0]).toMatchObject({ label: "Reply", style: 1 });
  });

  it("keeps @everyone in the review text", () => {
    const message = renderReview(input(stored({ body: "hello @everyone" })));
    expect(texts(message).join("\n")).toContain("hello @everyone");
    expect(message.allowedMentions?.users).toBeUndefined();
    expect(message.allowedMentions?.roles).toBeUndefined();
  });

  it("mentions only a 1 or 2 star review, inside the components", () => {
    const low = renderReview(
      input(stored({ rating: 2 }), { kind: "user", id: USER }),
    );
    const role = renderReview(
      input(stored({ rating: 1 }), { kind: "role", id: ROLE }),
    );
    const high = renderReview(
      input(stored({ rating: 5 }), { kind: "user", id: USER }),
    );
    expect(texts(low).join("\n")).toContain(`<@${USER}>`);
    expect(low.allowedMentions).toEqual({ users: [USER] });
    expect(low.content).toBeUndefined();
    expect(texts(role).join("\n")).toContain(`<@&${ROLE}>`);
    expect(role.allowedMentions).toEqual({ roles: [ROLE] });
    expect(texts(high).join("\n")).not.toContain(`<@${USER}>`);
    expect(high.allowedMentions).toBeUndefined();
    expect(low.flags).toBe(32768);
    expect(low.embeds).toBeUndefined();
  });

  it("cuts a long title and keeps the message text within 4000", () => {
    const message = renderReview(
      input(
        stored({
          rating: 5,
          title: "t".repeat(300),
          body: "b".repeat(5000),
          originalBody: "o".repeat(3000),
          language: "fr",
          device: "Pixel",
        }),
      ),
    );
    const joined = texts(message);
    const total = joined.reduce((sum, text) => sum + charLength(text), 0);
    expect(joined[0]?.endsWith("…")).toBe(true);
    expect(charLength(joined[0] ?? "")).toBeLessThanOrEqual(256);
    expect(total).toBeLessThanOrEqual(4000);
    expect(joined.some((text) => text.endsWith("…"))).toBe(true);
    for (const text of joined)
      expect(charLength(text)).toBeLessThanOrEqual(4000);
  });

  it("shows Reply, Edit reply, and the console link", () => {
    expect(buttons(renderReview(input(stored({ replyText: null }))))).toEqual([
      { label: "Reply", style: 1, custom_id: "reply:7" },
    ]);
    expect(
      buttons(
        renderReview(
          input(
            stored({ replyText: "Thanks" }),
            null,
            "https://play.google.com/console",
          ),
        ),
      ),
    ).toEqual([
      { label: "Edit reply", style: 2, custom_id: "reply:7" },
      {
        label: "Open in Play Console",
        style: 5,
        url: "https://play.google.com/console",
      },
    ]);
  });
});

describe("renderNotice", () => {
  it("renders warnings and recoveries from their codes", () => {
    expect(
      texts(renderNotice({ kind: "warning", warning: "google_auth" })),
    ).toEqual([
      "⚠️ Atticus can't sign in to Google, so reviews aren't being checked. README → Troubleshooting → Google sign-in.",
    ]);
    expect(
      texts(
        renderNotice({
          kind: "warning",
          warning: "play_forbidden",
          appName: "Lune",
        }),
      ),
    ).toEqual([
      "⚠️ Atticus doesn't have permission to read reviews for **Lune**. New permissions can take up to a day to apply. README → Troubleshooting → Permission denied.",
    ]);
    expect(
      texts(renderNotice({ kind: "recovered", subject: "google_auth" })),
    ).toEqual(["✓ Back to normal: Google sign-in is working again."]);
    expect(
      texts(
        renderNotice({
          kind: "recovered",
          subject: "play_forbidden",
          appName: "Lune",
        }),
      ),
    ).toEqual([
      "✓ Back to normal: reading reviews for **Lune** is working again.",
    ]);
  });

  it("uses the connected line for post, silent, and none", () => {
    expect(notice(4, "post")).toBe(
      "Connected to **Lune** ✓ Found 4 written reviews from the last 7 days. Posting them below, oldest first.",
    );
    expect(notice(4, "silent")).toContain(
      "They're saved; only new reviews will be posted.",
    );
    expect(notice(0, "post")).toBe(
      "Connected to **Lune** ✓ No written reviews in the last 7 days. New ones will appear here.",
    );
    expect(
      buttons(
        renderNotice({
          kind: "connected",
          appName: "Lune",
          count: 1,
          backfill: "post",
        }),
      ),
    ).toEqual([]);
  });
});

describe("allowed mentions on the wire", () => {
  it("sends parse empty for a review that says @everyone", async () => {
    const body = renderReview(input(stored({ body: "hello @everyone" })));
    const sent = await capture(body);
    expect(sent).toMatchObject({
      allowed_mentions: { parse: [] },
      flags: 32768,
    });
    expect(JSON.stringify(sent)).toContain("hello @everyone");
    expect(JSON.stringify(sent)).not.toContain('"everyone"');
    expect(JSON.stringify(sent)).not.toContain('"embeds"');
  });
});

function notice(count: number, backfill: "post" | "silent"): string {
  return texts(
    renderNotice({ kind: "connected", appName: "Lune", count, backfill }),
  ).join("\n");
}

function input(
  review: StoredReview,
  mention: ReviewMessageInput["mention"] = null,
  consoleUrl: string | null = null,
  showUpdated = false,
): ReviewMessageInput {
  return { review, appName: "Lune", consoleUrl, mention, showUpdated };
}

function stored(overrides: Partial<StoredReview> = {}): StoredReview {
  return {
    id: 7,
    store: "play",
    appId: "com.fusionfroze.Lune",
    reviewId: "review-1",
    rating: 5,
    previousRating: null,
    title: null,
    body: "Calm and quiet.",
    originalBody: null,
    language: "en",
    author: "Avery",
    appVersionName: "1.2.0",
    appVersionCode: 12,
    osVersion: "34",
    device: "Pixel",
    thumbsUp: 0,
    modifiedAt: 1_700_000_000,
    firstSeenAt: 1_700_000_000,
    replyText: null,
    replyModifiedAt: null,
    repliedVia: null,
    repliedBy: null,
    repliedAt: null,
    ...overrides,
  };
}

function texts(body: DiscordMessageBody): string[] {
  const found: string[] = [];
  walk(body.components, found);
  return found;
}

function walk(
  components: DiscordMessageBody["components"],
  found: string[],
): void {
  for (const component of components ?? []) {
    if (!isRecord(component)) continue;
    if (typeof component.content === "string") found.push(component.content);
    if (Array.isArray(component.components)) {
      walk(component.components as DiscordMessageBody["components"], found);
    }
  }
}

function colorOf(body: DiscordMessageBody): number | undefined {
  const container = body.components?.[0];
  if (isRecord(container) && typeof container.accent_color === "number") {
    return container.accent_color;
  }
  return undefined;
}

type ButtonShape = {
  label?: string;
  style?: number;
  custom_id?: string;
  url?: string;
};

function buttons(body: DiscordMessageBody): ButtonShape[] {
  const found: ButtonShape[] = [];
  walkButtons(body.components, found);
  return found;
}

function walkButtons(
  components: DiscordMessageBody["components"],
  found: ButtonShape[],
): void {
  for (const component of components ?? []) {
    if (!isRecord(component)) continue;
    if (component.type === 2) {
      const shape: ButtonShape = {};
      if (typeof component.label === "string") shape.label = component.label;
      if (typeof component.style === "number") shape.style = component.style;
      if (typeof component.custom_id === "string")
        shape.custom_id = component.custom_id;
      if (typeof component.url === "string") shape.url = component.url;
      found.push(shape);
    }
    if (Array.isArray(component.components)) {
      walkButtons(
        component.components as DiscordMessageBody["components"],
        found,
      );
    }
  }
}

function charLength(text: string): number {
  return Array.from(text).length;
}

async function capture(body: DiscordMessageBody): Promise<unknown> {
  const previous = globalThis.fetch;
  let sent: unknown;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent = JSON.parse(await request.text()) as unknown;
    return Response.json({ id: "323456789012345678" });
  }) as typeof fetch;
  try {
    await createDiscordClient({
      botToken: "test-bot-token",
      budget: createBudget(Date.now()),
    }).createMessage("223456789012345678", body, "o1");
  } finally {
    globalThis.fetch = previous;
  }
  return sent;
}
