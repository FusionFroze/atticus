import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getState } from "../src/store";
import {
  broken,
  emptyDatabase,
  expectQuiet,
  isToken,
  lune,
  playList,
  playReview,
  pollApps,
  tokenResponse,
  withCron,
} from "./cron-drive";

beforeEach(emptyDatabase);

describe("health", () => {
  it("warns once for a forbidden app, then recovers, while the other app polls", async () => {
    let brokenStatus = 403;
    const playUrls: string[] = [];
    const { lines } = await withCron(
      (request) => {
        if (isToken(request)) return tokenResponse();
        playUrls.push(request.url);
        if (request.url.includes(`/applications/${broken.id}/`)) {
          if (brokenStatus !== 200) {
            return new Response(null, { status: brokenStatus });
          }
          return playList([]);
        }
        if (request.url.includes(`/applications/${lune.id}/`)) {
          return playList([
            playReview({
              reviewId: "review-lune",
              text: "Lune body",
              rating: 5,
              seconds: "1700000000",
            }),
          ]);
        }
        return new Response("unexpected", { status: 500 });
      },
      async () => {
        await pollApps([broken, lune]);
        await pollApps([broken, lune]);
        expect(await warningPayloads()).toEqual([
          {
            notice: "warning",
            warning: "play_forbidden",
            appId: broken.id,
          },
        ]);
        expect(await getState(env.DB, `warn:play_forbidden:${broken.id}`)).toBe(
          "Broken",
        );
        brokenStatus = 200;
        await pollApps([broken, lune]);
      },
    );

    expect(
      playUrls.filter((url) => url.includes(lune.id)).length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      await getState(env.DB, `warn:play_forbidden:${broken.id}`),
    ).toBeNull();
    expect(await warningPayloads()).toHaveLength(1);
    expect(await recoveredPayloads()).toEqual([
      {
        notice: "recovered",
        subject: "play_forbidden",
        appName: "Broken",
      },
    ]);
    expect(
      events(lines).filter((event) => event.event === "warning_raised"),
    ).toEqual([
      { event: "warning_raised", kind: "play_forbidden", appId: broken.id },
    ]);
    expect(events(lines)).toContainEqual({
      event: "warning_cleared",
      kind: "play_forbidden",
      appId: broken.id,
    });
    expectQuiet(lines, ["Lune body"]);
  });

  it("warns once when Google sign-in fails", async () => {
    const urls: string[] = [];
    const { lines } = await withCron(
      (request) => {
        urls.push(request.url);
        return new Response(null, { status: 401 });
      },
      async () => {
        await pollApps([lune]);
        await pollApps([lune]);
      },
    );

    expect(urls.every((url) => isToken(new Request(url)))).toBe(true);
    expect(await warningPayloads()).toEqual([
      { notice: "warning", warning: "google_auth" },
    ]);
    expect(await getState(env.DB, "warn:google_auth")).toBe("1");
    expect(
      events(lines).filter((event) => event.event === "warning_raised"),
    ).toHaveLength(1);
    expectQuiet(lines, []);
  });

  it("skips a rate-limited app and does not warn", async () => {
    const playUrls: string[] = [];
    const { lines } = await withCron(
      (request) => {
        if (isToken(request)) return tokenResponse();
        playUrls.push(request.url);
        if (request.url.includes(`/applications/${broken.id}/`)) {
          return new Response(null, { status: 429 });
        }
        return playList([
          playReview({
            reviewId: "review-lune",
            text: "Lune body",
            rating: 5,
            seconds: "1700000000",
          }),
        ]);
      },
      () => pollApps([broken, lune]),
    );

    expect(playUrls.some((url) => url.includes(lune.id))).toBe(true);
    expect(await warningPayloads()).toEqual([]);
    expect(events(lines)).toContainEqual({
      event: "poll_failed",
      appId: broken.id,
      kind: "rate_limited",
    });
    expect(
      events(lines).some((event) => event.event === "warning_raised"),
    ).toBe(false);
    expectQuiet(lines, ["Lune body"]);
  });
});

async function warningPayloads(): Promise<unknown[]> {
  return payloads("warning");
}

async function recoveredPayloads(): Promise<unknown[]> {
  return payloads("recovered");
}

async function payloads(kind: string): Promise<unknown[]> {
  const rows = await env.DB.prepare(
    "SELECT payload FROM outbox WHERE kind = ? ORDER BY id",
  )
    .bind(kind)
    .all<{ payload: string }>();
  return rows.results.map((row) => JSON.parse(row.payload) as unknown);
}

function events(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}
