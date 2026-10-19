import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/types";
import type { Review, StoredReview } from "../src/core/review";
import {
  claimPending,
  finishRun,
  getState,
  insertReviewWithOutbox,
  markOutboxFailed,
  markOutboxRetry,
  markOutboxSent,
  pruneOutbox,
  readReview,
  readReviewForSend,
  readReviews,
  releaseLease,
  setState,
  startRun,
  updateReview,
  writeFirstRun,
} from "../src/store";

const APP = "com.fusionfroze.Lune";
const NOW = 1_800_000_000;

const app: AppConfig = {
  store: "play",
  id: APP,
  name: "Lune",
  consoleUrl: null,
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM reviews"),
    env.DB.prepare("DELETE FROM state"),
  ]);
});

describe("readReviews", () => {
  it("returns this app's rows and chunks past the parameter limit", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 101; index++) {
      const reviewId = `id-${String(index).padStart(3, "0")}`;
      ids.push(reviewId);
      await insertReviewWithOutbox(env.DB, {
        review: review({ reviewId }),
        nowSeconds: NOW,
        enqueue: false,
      });
    }
    await insertReviewWithOutbox(env.DB, {
      review: review({
        appId: "com.other",
        reviewId: "id-000",
        body: "other-app",
      }),
      nowSeconds: NOW,
      enqueue: false,
    });

    const found = await readReviews(env.DB, "play", APP, [...ids, "missing"]);
    expect(found.size).toBe(101);
    expect(found.has("missing")).toBe(false);
    expect(found.get("id-000")?.appId).toBe(APP);
    expect(await readReviews(env.DB, "play", APP, [])).toEqual(new Map());
    const other = await readReviews(env.DB, "play", "com.other", ["id-000"]);
    expect(other.get("id-000")?.body).toBe("other-app");
  });
});

describe("insertReviewWithOutbox", () => {
  it("links the outbox row to the new review, and can skip the enqueue", async () => {
    const withReply = review({
      developerReply: { text: "console-reply", modifiedAt: 40 },
    });
    const id = await insertReviewWithOutbox(env.DB, {
      review: withReply,
      nowSeconds: NOW,
      enqueue: true,
    });
    const row = await one(withReply.reviewId);
    expect(row.id).toBe(id);
    expect(row).toMatchObject({
      firstSeenAt: NOW,
      previousRating: null,
      replyText: "console-reply",
      replyModifiedAt: 40,
      repliedVia: "external",
      repliedBy: null,
      repliedAt: null,
    });
    const queued = await outbox();
    expect(queued).toEqual([
      expect.objectContaining({
        kind: "review_new",
        review_pk: id,
        payload: "{}",
        status: "pending",
        sort_key: withReply.modifiedAt,
        attempts: 0,
      }),
    ]);
    expect(queued[0]?.payload).not.toContain("console-reply");

    await insertReviewWithOutbox(env.DB, {
      review: review({ reviewId: "quiet" }),
      nowSeconds: NOW,
      enqueue: false,
    });
    expect(await outbox()).toHaveLength(1);
  });
});

describe("updateReview", () => {
  it("writes an edit, the previous rating, and a review_edited row", async () => {
    const original = await save(
      review({ rating: 4, body: "Stored body" }),
      false,
    );
    const edited = review({
      rating: 2,
      body: "Edited body",
      title: "Night",
      thumbsUp: 3,
      modifiedAt: original.modifiedAt + 10,
    });
    await updateReview(env.DB, {
      stored: original,
      review: edited,
      nowSeconds: NOW + 1,
      outcome: "edited",
    });
    expect(await one(original.reviewId)).toMatchObject({
      rating: 2,
      previousRating: 4,
      title: "Night",
      body: "Edited body",
      thumbsUp: 3,
      modifiedAt: edited.modifiedAt,
      firstSeenAt: NOW,
    });
    expect(await outbox()).toEqual([
      expect.objectContaining({
        kind: "review_edited",
        review_pk: original.id,
        payload: "{}",
        sort_key: edited.modifiedAt,
      }),
    ]);
  });

  it("keeps bot attribution only when the reply text is unchanged", async () => {
    const kept = await save(review({ reviewId: "kept" }), false);
    await setBot(kept.id, "Thanks");
    await updateReview(env.DB, {
      stored: await one("kept"),
      review: review({
        reviewId: "kept",
        body: "Edited body",
        modifiedAt: kept.modifiedAt + 5,
        developerReply: { text: "Thanks", modifiedAt: 70 },
      }),
      nowSeconds: NOW,
      outcome: "edited",
    });
    expect(await one("kept")).toMatchObject({
      body: "Edited body",
      replyText: "Thanks",
      replyModifiedAt: 70,
      repliedVia: "bot",
      repliedBy: "user-1",
      repliedAt: 60,
    });

    const changed = await save(review({ reviewId: "changed" }), false);
    await setBot(changed.id, "Thanks");
    await updateReview(env.DB, {
      stored: await one("changed"),
      review: review({
        reviewId: "changed",
        modifiedAt: changed.modifiedAt + 5,
        developerReply: { text: "Different", modifiedAt: 80 },
      }),
      nowSeconds: NOW,
      outcome: "edited",
    });
    expect(await one("changed")).toMatchObject({
      replyText: "Different",
      replyModifiedAt: 80,
      repliedVia: "external",
      repliedBy: null,
      repliedAt: null,
    });

    const cleared = await save(review({ reviewId: "cleared" }), false);
    await setBot(cleared.id, "Thanks");
    await updateReview(env.DB, {
      stored: await one("cleared"),
      review: review({
        reviewId: "cleared",
        modifiedAt: cleared.modifiedAt + 5,
        developerReply: null,
      }),
      nowSeconds: NOW,
      outcome: "edited",
    });
    expect(await one("cleared")).toMatchObject({
      replyText: null,
      replyModifiedAt: null,
      repliedVia: null,
      repliedBy: null,
      repliedAt: null,
    });
  });

  it("updates only the columns each outcome names", async () => {
    const seen = await save(
      review({ reviewId: "seen", body: "Same body" }),
      false,
    );
    await setBot(seen.id, "Thanks");
    await updateReview(env.DB, {
      stored: await one("seen"),
      review: review({
        reviewId: "seen",
        body: "Same body",
        thumbsUp: 9,
        developerReply: { text: "Thanks", modifiedAt: 90 },
      }),
      nowSeconds: NOW,
      outcome: "own_reply_seen",
    });
    expect(await one("seen")).toMatchObject({
      body: "Same body",
      thumbsUp: 0,
      replyModifiedAt: 90,
      repliedVia: "bot",
      repliedBy: "user-1",
    });

    const elsewhere = await save(review({ reviewId: "elsewhere" }), false);
    await updateReview(env.DB, {
      stored: elsewhere,
      review: review({
        reviewId: "elsewhere",
        developerReply: { text: "From console", modifiedAt: 91 },
      }),
      nowSeconds: NOW,
      outcome: "replied_elsewhere",
    });
    expect(await one("elsewhere")).toMatchObject({
      body: "Stored body",
      replyText: "From console",
      replyModifiedAt: 91,
      repliedVia: "external",
      repliedBy: null,
      repliedAt: null,
    });

    await updateReview(env.DB, {
      stored: await one("elsewhere"),
      review: review({ reviewId: "elsewhere", developerReply: null }),
      nowSeconds: NOW,
      outcome: "reply_removed",
    });
    expect(await one("elsewhere")).toMatchObject({
      replyText: null,
      replyModifiedAt: null,
      repliedVia: null,
    });

    const thumbs = await save(
      review({ reviewId: "thumbs", thumbsUp: 1 }),
      false,
    );
    await updateReview(env.DB, {
      stored: thumbs,
      review: review({ reviewId: "thumbs", thumbsUp: 6, body: "Ignored" }),
      nowSeconds: NOW,
      outcome: "thumbs_changed",
    });
    expect(await one("thumbs")).toMatchObject({
      thumbsUp: 6,
      body: "Stored body",
    });
    expect((await outbox()).map((row) => row.kind)).toEqual(["message_update"]);
  });

  it("coalesces an edit into a pending review_new or review_edited", async () => {
    const fresh = await save(review({ reviewId: "fresh", body: "First" }));
    await updateReview(env.DB, {
      stored: fresh,
      review: review({
        reviewId: "fresh",
        body: "Second",
        modifiedAt: fresh.modifiedAt + 1,
      }),
      nowSeconds: NOW,
      outcome: "edited",
    });
    expect(await one("fresh")).toMatchObject({ body: "Second" });
    expect(await outbox()).toEqual([
      expect.objectContaining({ kind: "review_new", review_pk: fresh.id }),
    ]);

    const again = await save(
      review({ reviewId: "again", body: "First" }),
      false,
    );
    await updateReview(env.DB, {
      stored: again,
      review: review({
        reviewId: "again",
        body: "Second",
        modifiedAt: again.modifiedAt + 1,
      }),
      nowSeconds: NOW,
      outcome: "edited",
    });
    await updateReview(env.DB, {
      stored: await one("again"),
      review: review({
        reviewId: "again",
        body: "Third",
        modifiedAt: again.modifiedAt + 2,
      }),
      nowSeconds: NOW,
      outcome: "edited",
    });
    expect(await one("again")).toMatchObject({ body: "Third" });
    const queued = (await outbox()).filter((row) => row.review_pk === again.id);
    expect(queued).toEqual([
      expect.objectContaining({ kind: "review_edited", review_pk: again.id }),
    ]);
  });

  it("coalesces a message_update into a pending message_update or review_new", async () => {
    const fresh = await save(review({ reviewId: "fresh-reply" }));
    await updateReview(env.DB, {
      stored: fresh,
      review: review({
        reviewId: "fresh-reply",
        developerReply: { text: "From console", modifiedAt: 5 },
      }),
      nowSeconds: NOW,
      outcome: "replied_elsewhere",
    });
    expect(await one("fresh-reply")).toMatchObject({ repliedVia: "external" });
    expect((await outbox()).map((row) => row.kind)).toEqual(["review_new"]);

    const posted = await save(review({ reviewId: "posted" }), false);
    await updateReview(env.DB, {
      stored: posted,
      review: review({
        reviewId: "posted",
        developerReply: { text: "From console", modifiedAt: 5 },
      }),
      nowSeconds: NOW,
      outcome: "replied_elsewhere",
    });
    await updateReview(env.DB, {
      stored: await one("posted"),
      review: review({ reviewId: "posted", developerReply: null }),
      nowSeconds: NOW,
      outcome: "reply_removed",
    });
    expect(await one("posted")).toMatchObject({ replyText: null });
    expect(
      (await outbox()).filter((row) => row.review_pk === posted.id),
    ).toEqual([expect.objectContaining({ kind: "message_update" })]);

    const edited = await save(review({ reviewId: "edited-reply" }), false);
    await updateReview(env.DB, {
      stored: edited,
      review: review({
        reviewId: "edited-reply",
        body: "Changed",
        modifiedAt: edited.modifiedAt + 1,
      }),
      nowSeconds: NOW,
      outcome: "edited",
    });
    await updateReview(env.DB, {
      stored: await one("edited-reply"),
      review: review({
        reviewId: "edited-reply",
        body: "Changed",
        modifiedAt: edited.modifiedAt + 1,
        developerReply: { text: "From console", modifiedAt: 6 },
      }),
      nowSeconds: NOW,
      outcome: "replied_elsewhere",
    });
    expect(
      (await outbox())
        .filter((row) => row.review_pk === edited.id)
        .map((row) => row.kind),
    ).toEqual(["review_edited", "message_update"]);
  });
});

describe("startRun", () => {
  it("holds for ten minutes and release deletes only that value", async () => {
    const first = await startRun(env.DB, 1_000, "run-a");
    expect(first?.lease).toBe("1600:run-a");
    expect(await getState(env.DB, "lease")).toBe("1600:run-a");
    expect(await startRun(env.DB, 1_599, "run-b")).toBeNull();
    expect(await getState(env.DB, "lease")).toBe("1600:run-a");
    const second = await startRun(env.DB, 1_600, "run-b");
    expect(second?.lease).toBe("2200:run-b");
    await releaseLease(env.DB, "1600:run-a");
    expect(await getState(env.DB, "lease")).toBe("2200:run-b");
    await releaseLease(env.DB, "2200:run-b");
    expect(await getState(env.DB, "lease")).toBeNull();

    const colon = await startRun(env.DB, 2_000, "run:a");
    await releaseLease(env.DB, colon?.lease ?? "");
    expect(await getState(env.DB, "lease")).toBeNull();
  });

  it("returns every state row, including the lease it took", async () => {
    await setState(env.DB, "digest_last", "2026-10-19", 900);
    const started = await startRun(env.DB, 1_000, "run-a");
    expect(started?.state).toEqual(
      new Map([
        ["digest_last", "2026-10-19"],
        ["lease", "1600:run-a"],
      ]),
    );
  });

  it("finishes in one batch: last_poll_at, the prune, the release", async () => {
    const started = await startRun(env.DB, 1_000, "run-a");
    await finishRun(env.DB, { lease: started?.lease ?? "", nowSeconds: 1_000 });
    expect(await getState(env.DB, "lease")).toBeNull();
    expect(await getState(env.DB, "last_poll_at")).toBe("1000");
  });
});

describe("getState", () => {
  it("returns null when missing and overwrites a value", async () => {
    expect(await getState(env.DB, "digest_last")).toBeNull();
    await setState(env.DB, "digest_last", "2026-10-12", 10);
    expect(await getState(env.DB, "digest_last")).toBe("2026-10-12");
    await setState(env.DB, "digest_last", "2026-10-19", 20);
    expect(
      await env.DB.prepare(
        "SELECT value, updated_at FROM state WHERE key = 'digest_last'",
      ).first(),
    ).toEqual({ value: "2026-10-19", updated_at: 20 });
  });
});

describe("claimPending", () => {
  it("orders by sort_key then id and skips a future attempt", async () => {
    await writeFirstRun(env.DB, {
      app,
      reviews: [
        review({ reviewId: "newer", modifiedAt: 300 }),
        review({ reviewId: "older", modifiedAt: 100 }),
        review({ reviewId: "tie-b", modifiedAt: 200 }),
        review({ reviewId: "tie-a", modifiedAt: 200 }),
      ],
      backfill: "post",
      nowSeconds: NOW,
    });
    const claimed = await claimPending(env.DB, NOW, 10);
    expect(await reviewIds(claimed.map((row) => row.reviewPk))).toEqual([
      "connected",
      "older",
      "tie-a",
      "tie-b",
      "newer",
    ]);
    expect(claimed.every((row) => row.status === "pending")).toBe(true);

    const newer = claimed.find((row) => row.sortKey === 300);
    await env.DB.prepare("UPDATE outbox SET next_attempt_at = ? WHERE id = ?")
      .bind(NOW + 1, newer?.id ?? 0)
      .run();
    const due = await claimPending(env.DB, NOW, 10);
    expect(due.map((row) => row.sortKey)).toEqual([0, 100, 200, 200]);
    expect(await claimPending(env.DB, NOW, 2)).toHaveLength(2);

    expect(
      (await claimPending(env.DB, NOW, 10, ["connected"])).map(
        (row) => row.kind,
      ),
    ).toEqual(["connected"]);
    expect(await claimPending(env.DB, NOW, 10, ["digest"])).toEqual([]);
    expect(await claimPending(env.DB, NOW, 10, [])).toEqual([]);
  });
});

describe("readReview", () => {
  it("returns the stored row and its latest message", async () => {
    const stored = await save(review());
    expect(await readReview(env.DB, stored.id)).toMatchObject({
      id: stored.id,
      reviewId: "review-1",
      body: "Stored body",
    });
    expect(await readReview(env.DB, stored.id + 1)).toBeNull();
    expect((await readReviewForSend(env.DB, stored.id))?.latest).toBeNull();
    expect(await readReviewForSend(env.DB, stored.id + 1)).toBeNull();

    const pending = (await outbox()).find((row) => row.kind === "review_new");
    if (pending === undefined) throw new Error("missing review_new");
    await markOutboxSent(env.DB, {
      outboxId: pending.id,
      reviewPk: stored.id,
      channelId: "channel-1",
      messageId: "message-1",
      version: stored.modifiedAt,
      nowSeconds: NOW,
    });
    await markOutboxSent(env.DB, {
      outboxId: pending.id,
      reviewPk: stored.id,
      channelId: "channel-1",
      messageId: "message-2",
      version: stored.modifiedAt,
      nowSeconds: NOW + 1,
    });
    const forSend = await readReviewForSend(env.DB, stored.id);
    expect(forSend?.latest).toEqual({
      channelId: "channel-1",
      messageId: "message-2",
    });
    expect(forSend?.review).toEqual(await readReview(env.DB, stored.id));
  });
});

describe("markOutboxSent", () => {
  it("records the message and leaves a connected row without one", async () => {
    await writeFirstRun(env.DB, {
      app,
      reviews: [],
      backfill: "silent",
      nowSeconds: NOW,
    });
    const connected = (await outbox())[0];
    if (connected === undefined) throw new Error("missing connected row");
    await markOutboxSent(env.DB, {
      outboxId: connected.id,
      reviewPk: null,
      channelId: "channel-1",
      messageId: "message-connected",
      version: 0,
      nowSeconds: NOW,
    });
    expect(await messageCount()).toBe(0);
    expect((await outbox())[0]).toMatchObject({ status: "sent", sent_at: NOW });

    const row = await save(review());
    const pending = (await outbox()).find(
      (entry) => entry.kind === "review_new",
    );
    if (pending === undefined) throw new Error("missing review_new");
    await markOutboxSent(env.DB, {
      outboxId: pending.id,
      reviewPk: row.id,
      channelId: "channel-1",
      messageId: "message-1",
      version: row.modifiedAt,
      nowSeconds: NOW + 1,
    });
    await markOutboxSent(env.DB, {
      outboxId: pending.id,
      reviewPk: row.id,
      channelId: "channel-1",
      messageId: "message-2",
      version: row.modifiedAt,
      nowSeconds: NOW + 2,
    });
    expect(await messages()).toEqual([
      expect.objectContaining({
        review_pk: row.id,
        message_id: "message-1",
        is_latest: 0,
        version: row.modifiedAt,
      }),
      expect.objectContaining({
        review_pk: row.id,
        message_id: "message-2",
        is_latest: 1,
      }),
    ]);
  });
});

describe("markOutboxRetry", () => {
  it("records the next attempt and a failure without inventing a backoff", async () => {
    const retried = await save(review({ reviewId: "retried" }));
    const failed = await save(review({ reviewId: "failed" }));
    const rows = await outbox();
    const retryId = rows.find((row) => row.review_pk === retried.id)?.id;
    const failId = rows.find((row) => row.review_pk === failed.id)?.id;
    if (retryId === undefined || failId === undefined) {
      throw new Error("missing outbox row");
    }
    await markOutboxRetry(env.DB, retryId, NOW + 60, "500");
    await markOutboxFailed(env.DB, failId, "400");
    const after = await outbox();
    expect(after.find((row) => row.id === retryId)).toMatchObject({
      status: "pending",
      attempts: 1,
      next_attempt_at: NOW + 60,
      last_error: "500",
    });
    expect(after.find((row) => row.id === failId)).toMatchObject({
      status: "failed",
      attempts: 0,
      last_error: "400",
    });
  });
});

describe("pruneOutbox", () => {
  it("deletes sent and failed rows older than 30 days and keeps pending", async () => {
    const ids = {
      oldSent: (await save(review({ reviewId: "old-sent" }))).id,
      freshSent: (await save(review({ reviewId: "fresh-sent" }))).id,
      oldFailed: (await save(review({ reviewId: "old-failed" }))).id,
      freshFailed: (await save(review({ reviewId: "fresh-failed" }))).id,
      pending: (await save(review({ reviewId: "still-pending" }))).id,
    };
    const rows = await outbox();
    const idFor = (reviewPk: number) => {
      const row = rows.find((entry) => entry.review_pk === reviewPk);
      if (row === undefined) throw new Error("missing outbox row");
      return row.id;
    };
    const day = 30 * 24 * 60 * 60;
    const now = 2_000_000_000;
    await setOutbox(idFor(ids.oldSent), {
      status: "sent",
      createdAt: now - day - 10,
      sentAt: now - day - 1,
    });
    await setOutbox(idFor(ids.freshSent), {
      status: "sent",
      createdAt: 1,
      sentAt: now - day,
    });
    await setOutbox(idFor(ids.oldFailed), {
      status: "failed",
      createdAt: now - day - 1,
    });
    await setOutbox(idFor(ids.freshFailed), {
      status: "failed",
      createdAt: now - day,
    });
    await setOutbox(idFor(ids.pending), { createdAt: 1 });

    expect(await pruneOutbox(env.DB, now)).toBe(2);
    const left = await outbox();
    expect(left.map((row) => row.review_pk).sort()).toEqual(
      [ids.freshFailed, ids.freshSent, ids.pending].sort(),
    );
  });
});

describe("writeFirstRun", () => {
  it("posts oldest first, then connected, and links each outbox row", async () => {
    const older = review({
      reviewId: "older",
      modifiedAt: 100,
      body: "older-body",
      developerReply: { text: "console-reply", modifiedAt: 150 },
    });
    const newer = review({
      reviewId: "newer",
      modifiedAt: 300,
      body: "newer-body",
    });
    await writeFirstRun(env.DB, {
      app,
      reviews: [newer, older],
      backfill: "post",
      nowSeconds: NOW,
    });

    const links = await env.DB.prepare(
      `SELECT r.review_id, r.id, r.first_seen_at, r.replied_via, o.review_pk, o.kind, o.sort_key, o.payload
       FROM reviews r
       JOIN outbox o ON o.review_pk = r.id AND o.kind = 'review_new'
       ORDER BY r.modified_at`,
    ).all<{
      review_id: string;
      id: number;
      first_seen_at: number;
      replied_via: string | null;
      review_pk: number;
      kind: string;
      sort_key: number;
      payload: string;
    }>();
    expect(links.results.map((row) => row.review_id)).toEqual([
      "older",
      "newer",
    ]);
    for (const row of links.results) {
      expect(row.review_pk).toBe(row.id);
      expect(row.payload).toBe("{}");
      expect(row.first_seen_at).toBe(NOW);
    }
    expect(links.results[0]).toMatchObject({
      replied_via: "external",
      sort_key: 100,
    });
    expect(links.results[1]).toMatchObject({ sort_key: 300 });

    const queued = await outbox();
    expect(queued.map((row) => row.kind)).toEqual([
      "review_new",
      "review_new",
      "connected",
    ]);
    const connected = queued[2];
    expect(connected).toMatchObject({
      review_pk: null,
      sort_key: 0,
      status: "pending",
    });
    expect(JSON.parse(connected?.payload ?? "{}")).toEqual({
      store: "play",
      appId: APP,
      appName: "Lune",
      count: 2,
      backfill: "post",
    });
    expect(connected?.payload).not.toContain("older-body");
    expect(connected?.payload).not.toContain("console-reply");
    expect(await getState(env.DB, `app_seen:play:${APP}`)).toBe("1");
  });

  it("stores a silent run and an empty window without review_new rows", async () => {
    await writeFirstRun(env.DB, {
      app,
      reviews: [review({ body: "silent-body" })],
      backfill: "silent",
      nowSeconds: NOW,
    });
    expect(await outbox()).toEqual([
      expect.objectContaining({
        kind: "connected",
        sort_key: 0,
        review_pk: null,
      }),
    ]);
    expect(JSON.parse((await outbox())[0]?.payload ?? "{}")).toMatchObject({
      count: 1,
      backfill: "silent",
    });
    expect((await outbox())[0]?.payload).not.toContain("silent-body");
    expect(await one("review-1")).toMatchObject({ body: "silent-body" });

    await env.DB.batch([
      env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM reviews"),
      env.DB.prepare("DELETE FROM state"),
    ]);
    await writeFirstRun(env.DB, {
      app,
      reviews: [],
      backfill: "post",
      nowSeconds: NOW,
    });
    expect(JSON.parse((await outbox())[0]?.payload ?? "{}")).toMatchObject({
      count: 0,
      backfill: "post",
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews").first<{
        n: number;
      }>(),
    ).toEqual({ n: 0 });
    expect(await getState(env.DB, `app_seen:play:${APP}`)).toBe("1");
  });
});

function review(overrides: Partial<Review> = {}): Review {
  return {
    store: "play",
    appId: APP,
    reviewId: "review-1",
    author: "Avery",
    rating: 4,
    title: null,
    body: "Stored body",
    originalBody: null,
    language: "en",
    appVersionName: "2.4.0",
    appVersionCode: 120,
    osVersion: "34",
    device: "Sample Phone",
    thumbsUp: 0,
    modifiedAt: 1_700_000_000,
    developerReply: null,
    ...overrides,
  };
}

async function save(next: Review, enqueue = true): Promise<StoredReview> {
  await insertReviewWithOutbox(env.DB, {
    review: next,
    nowSeconds: NOW,
    enqueue,
  });
  return one(next.reviewId, next.appId);
}

async function one(reviewId: string, appId = APP): Promise<StoredReview> {
  const found = await readReviews(env.DB, "play", appId, [reviewId]);
  const row = found.get(reviewId);
  if (row === undefined) throw new Error(`missing ${reviewId}`);
  return row;
}

async function setBot(id: number, text: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE reviews
     SET reply_text = ?, reply_modified_at = 50, replied_via = 'bot',
         replied_by = 'user-1', replied_at = 60
     WHERE id = ?`,
  )
    .bind(text, id)
    .run();
}

type OutboxRecord = {
  id: number;
  kind: string;
  review_pk: number | null;
  payload: string;
  status: string;
  sort_key: number;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  sent_at: number | null;
  created_at: number;
};

async function outbox(): Promise<OutboxRecord[]> {
  const result = await env.DB.prepare(
    `SELECT id, kind, review_pk, payload, status, sort_key, attempts,
            next_attempt_at, last_error, sent_at, created_at
     FROM outbox ORDER BY id`,
  ).all<OutboxRecord>();
  return result.results;
}

async function reviewIds(reviewPks: (number | null)[]): Promise<string[]> {
  const names: string[] = [];
  for (const reviewPk of reviewPks) {
    if (reviewPk === null) {
      names.push("connected");
      continue;
    }
    const row = await env.DB.prepare(
      "SELECT review_id FROM reviews WHERE id = ?",
    )
      .bind(reviewPk)
      .first<{ review_id: string }>();
    names.push(row?.review_id ?? "missing");
  }
  return names;
}

async function messages(): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare(
    `SELECT review_pk, version, channel_id, message_id, is_latest, created_at
     FROM messages ORDER BY id`,
  ).all();
  return result.results;
}

async function messageCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

async function setOutbox(
  id: number,
  fields: { status?: string; createdAt?: number; sentAt?: number },
): Promise<void> {
  if (fields.status !== undefined) {
    await env.DB.prepare("UPDATE outbox SET status = ? WHERE id = ?")
      .bind(fields.status, id)
      .run();
  }
  if (fields.createdAt !== undefined) {
    await env.DB.prepare("UPDATE outbox SET created_at = ? WHERE id = ?")
      .bind(fields.createdAt, id)
      .run();
  }
  if (fields.sentAt !== undefined) {
    await env.DB.prepare("UPDATE outbox SET sent_at = ? WHERE id = ?")
      .bind(fields.sentAt, id)
      .run();
  }
}
