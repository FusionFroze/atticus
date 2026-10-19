import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CHANNEL,
  type DiscordCall,
  emptyDatabase,
  expectQuiet,
  GUILD,
  isDiscord,
  isToken,
  labels,
  latestMessageId,
  playList,
  playReview,
  pollApps,
  readCall,
  sendOutbox,
  texts,
  tokenResponse,
  withCron,
} from "./cron-drive";

const AUTHOR = "Fixture Author";

beforeEach(emptyDatabase);

describe("edits", () => {
  it("replies to the previous message and leaves buttons on the new one", async () => {
    let review = playReview({
      reviewId: "review-1",
      text: "Stored body",
      rating: 4,
      seconds: "1700000000",
    });
    const discord: DiscordCall[] = [];
    const { lines } = await withCron(
      async (request) => {
        if (isToken(request)) return tokenResponse();
        if (!isDiscord(request)) return playList([review]);
        const call = await readCall(request);
        discord.push(call);
        if (call.method === "GET") return storedMessage();
        if (call.method === "PATCH") return Response.json({ id: "old" });
        return Response.json({
          id: `m-${discord.length}`,
          guild_id: GUILD,
        });
      },
      async () => {
        await pollApps();
        await sendOutbox();
        const previous = await latestMessageId();
        review = playReview({
          reviewId: "review-1",
          text: "Edited body",
          rating: 2,
          seconds: "1700000100",
        });
        await pollApps();
        const before = discord.length;
        await sendOutbox();
        const sent = discord.slice(before);
        expect(sent.map((call) => call.method)).toEqual([
          "POST",
          "GET",
          "PATCH",
        ]);
        expect(sent[0]?.body.message_reference).toEqual({
          message_id: previous,
          fail_if_not_exists: false,
        });
        expect(texts(sent[0]?.body ?? {})).toEqual(
          expect.arrayContaining(["Review updated", "★4 → ★2", "Edited body"]),
        );
        expect(labels(sent[0]?.body ?? {})).toEqual(["Reply"]);
        expect(sent[1]?.url).toContain(`/messages/${previous}`);
        expect(sent[2]?.url).toContain(`/messages/${previous}`);
        expect(labels(sent[2]?.body ?? {})).toEqual([]);
        expect(JSON.stringify(sent[2]?.body)).toContain(
          `Updated, see the [newer message](https://discord.com/channels/${GUILD}/${CHANNEL}/`,
        );
        expect(JSON.stringify(sent[2]?.body)).not.toContain('"type":1,');
        const next = await latestMessageId();
        expect(next).not.toBe(previous);
        const old = await env.DB.prepare(
          "SELECT is_latest FROM messages WHERE message_id = ?",
        )
          .bind(previous)
          .first<{ is_latest: number }>();
        expect(old?.is_latest).toBe(0);
      },
    );
    expectQuiet(lines, [AUTHOR, "Stored body", "Edited body", "keep-me"]);
  });

  it("sends one message, the latest text, when the edit arrives first", async () => {
    let review = playReview({
      reviewId: "review-1",
      text: "Stored body",
      rating: 4,
      seconds: "1700000000",
    });
    const discord: DiscordCall[] = [];
    const { lines } = await withCron(
      async (request) => {
        if (isToken(request)) return tokenResponse();
        if (!isDiscord(request)) return playList([review]);
        const call = await readCall(request);
        discord.push(call);
        return Response.json({ id: `m-${discord.length}`, guild_id: GUILD });
      },
      async () => {
        await pollApps();
        review = playReview({
          reviewId: "review-1",
          text: "Edited body",
          rating: 1,
          seconds: "1700000100",
        });
        await pollApps();
        await sendOutbox();
      },
    );

    expect(discord.map((call) => call.method)).toEqual(["POST", "POST"]);
    const reviewPost = discord[1];
    expect(texts(reviewPost?.body ?? {})).toContain("Edited body");
    expect(texts(reviewPost?.body ?? {})).not.toContain("Review updated");
    expect(texts(reviewPost?.body ?? {})).not.toContain("Stored body");
    expect(reviewPost?.body.message_reference).toBeUndefined();
    expect(await latestMessageId()).toBe("m-2");
    expectQuiet(lines, [AUTHOR, "Stored body", "Edited body"]);
  });

  it("patches a Play Console reply onto the current message", async () => {
    let review = playReview({
      reviewId: "review-1",
      text: "Stored body",
      rating: 4,
      seconds: "1700000100",
    });
    const discord: DiscordCall[] = [];
    const { lines } = await withCron(
      async (request) => {
        if (isToken(request)) return tokenResponse();
        if (!isDiscord(request)) return playList([review]);
        const call = await readCall(request);
        discord.push(call);
        return Response.json({ id: `m-${discord.length}`, guild_id: GUILD });
      },
      async () => {
        await pollApps();
        await sendOutbox();
        review = playReview({
          reviewId: "review-1",
          text: "Stored body",
          rating: 4,
          seconds: "1700000100",
          reply: { text: "Thanks from console", seconds: "1700000200" },
        });
        await pollApps();
        const before = discord.length;
        await sendOutbox();
        const patch = discord.slice(before);
        expect(patch.map((call) => call.method)).toEqual(["PATCH"]);
        expect(texts(patch[0]?.body ?? {}).join("\n")).toContain(
          "**Your reply**\nThanks from console",
        );
        expect(texts(patch[0]?.body ?? {}).join("\n")).toContain(
          "Replied in Play Console · <t:1700000200:R>",
        );
        expect(labels(patch[0]?.body ?? {})).toEqual(["Edit reply"]);
      },
    );
    expectQuiet(lines, [AUTHOR, "Stored body", "Thanks from console"]);
  });

  it("removes a Play Console reply and shows Reply again", async () => {
    let review = playReview({
      reviewId: "review-1",
      text: "Stored body",
      rating: 4,
      seconds: "1700000100",
      reply: { text: "Thanks from console", seconds: "1700000200" },
    });
    const discord: DiscordCall[] = [];
    const { lines } = await withCron(
      async (request) => {
        if (isToken(request)) return tokenResponse();
        if (!isDiscord(request)) return playList([review]);
        const call = await readCall(request);
        discord.push(call);
        return Response.json({ id: `m-${discord.length}`, guild_id: GUILD });
      },
      async () => {
        await pollApps();
        await sendOutbox();
        review = playReview({
          reviewId: "review-1",
          text: "Stored body",
          rating: 4,
          seconds: "1700000100",
        });
        await pollApps();
        const before = discord.length;
        await sendOutbox();
        const patch = discord[before];
        expect(patch?.method).toBe("PATCH");
        expect(texts(patch?.body ?? {}).join("\n")).not.toContain("Your reply");
        expect(labels(patch?.body ?? {})).toEqual(["Reply"]);
      },
    );
    expectQuiet(lines, [AUTHOR, "Stored body", "Thanks from console"]);
  });

  it("reposts a deleted message and makes that the latest", async () => {
    let review = playReview({
      reviewId: "review-1",
      text: "Stored body",
      rating: 4,
      seconds: "1700000100",
    });
    const discord: DiscordCall[] = [];
    const { lines } = await withCron(
      async (request) => {
        if (isToken(request)) return tokenResponse();
        if (!isDiscord(request)) return playList([review]);
        const call = await readCall(request);
        discord.push(call);
        if (call.method === "PATCH") {
          return Response.json({ code: 10008 }, { status: 404 });
        }
        return Response.json({ id: `m-${discord.length}`, guild_id: GUILD });
      },
      async () => {
        await pollApps();
        await sendOutbox();
        const previous = await latestMessageId();
        review = playReview({
          reviewId: "review-1",
          text: "Stored body",
          rating: 4,
          seconds: "1700000100",
          reply: { text: "Thanks from console", seconds: "1700000200" },
        });
        await pollApps();
        const before = discord.length;
        await sendOutbox();
        const sent = discord.slice(before);
        expect(sent.map((call) => call.method)).toEqual(["PATCH", "POST"]);
        expect(sent[0]?.url).toContain(`/messages/${previous}`);
        expect(sent[1]?.body.message_reference).toBeUndefined();
        const next = await latestMessageId();
        expect(next).not.toBe(previous);
        const rows = await env.DB.prepare(
          "SELECT message_id, is_latest FROM messages ORDER BY id",
        ).all<{ message_id: string; is_latest: number }>();
        expect(rows.results).toEqual([
          { message_id: previous, is_latest: 0 },
          { message_id: next, is_latest: 1 },
        ]);
      },
    );
    expectQuiet(lines, [AUTHOR, "Stored body", "Thanks from console"]);
  });
});

function storedMessage(): Response {
  return Response.json({
    id: "old",
    components: [
      {
        type: 17,
        components: [
          { type: 10, content: "keep-me" },
          { type: 1, components: [{ type: 2, label: "Reply" }] },
        ],
      },
    ],
  });
}
