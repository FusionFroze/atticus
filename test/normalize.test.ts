import { describe, expect, it } from "vitest";
import type { Review } from "../src/core/review";
import type { ListedReview } from "../src/sources/play/client";
import {
  normalizeReview,
  type SkipReason,
} from "../src/sources/play/normalize";
import malformed from "./fixtures/play/malformed.json";
import page1 from "./fixtures/play/page-1.json";
import page2 from "./fixtures/play/page-2.json";

const APP = "com.fusionfroze.Lune";

const kept = {
  text: "Hello",
  lastModified: { seconds: "1700000000" },
  starRating: 5,
};

describe("normalizeReview", () => {
  it("splits a title on the first tab and prefers the product name", () => {
    expect(normalizeReview(APP, fixtureReview(page1, "review-full"))).toEqual(
      review({
        reviewId: "review-full",
        author: "Avery Quinn",
        rating: 2,
        title: "Night mode",
        body: "The lamp stays on after sunrise.",
        language: "en",
        appVersionName: "2.4.0",
        appVersionCode: 120,
        osVersion: "34",
        device: "Sample Phone",
        thumbsUp: 4,
        modifiedAt: 1_760_700_000,
        developerReply: {
          text: "Thanks, we are looking at that lamp.",
          modifiedAt: 1_760_710_000,
        },
      }),
    );
  });

  it("keeps a translated review's original text whole", () => {
    expect(
      normalizeReview(APP, fixtureReview(page1, "review-translated")),
    ).toEqual(
      review({
        reviewId: "review-translated",
        author: "Casey Morgan",
        rating: 4,
        body: "Translated sample: the alarm was late.",
        originalBody: "Exemple traduit.",
        language: "fr",
        modifiedAt: 1_760_720_000,
      }),
    );

    expect(
      normalizeReview(
        APP,
        raw("original-tab", {
          ...kept,
          text: "Translated title\tTranslated body",
          originalText: "Titre\tCorps",
        }),
      ),
    ).toMatchObject({
      title: "Translated title",
      body: "Translated body",
      originalBody: "Titre\tCorps",
    });
  });

  it("fills missing optional fields with null or zero", () => {
    expect(
      normalizeReview(APP, fixtureReview(page1, "review-minimal")),
    ).toEqual(
      review({
        reviewId: "review-minimal",
        rating: 5,
        body: "Five stars, no other details.",
        modifiedAt: 1_760_730_000,
      }),
    );
  });

  it("uses the device string when there is no product name", () => {
    expect(normalizeReview(APP, fixtureReview(page2, "review-page-2"))).toEqual(
      review({
        reviewId: "review-page-2",
        author: "Riley Chen",
        rating: 3,
        body: "No title on this one.",
        osVersion: "33",
        device: "fallback-device",
        modifiedAt: 1_760_740_000,
      }),
    );

    expect(
      normalizeReview(
        APP,
        raw("empty-product", {
          ...kept,
          device: "pixel",
          deviceMetadata: { productName: "" },
        }),
      ),
    ).toMatchObject({ device: "pixel" });
  });

  it("treats an empty title as no title and keeps later tabs in the body", () => {
    expect(
      normalizeReview(
        APP,
        raw("empty-title", { ...kept, text: "\tJust the body" }),
      ),
    ).toMatchObject({ title: null, body: "Just the body" });
    expect(
      normalizeReview(
        APP,
        raw("later-tabs", { ...kept, text: "Title\tline\tstill in the body" }),
      ),
    ).toMatchObject({ title: "Title", body: "line\tstill in the body" });
  });

  it("drops optional fields that are not the documented shape", () => {
    expect(
      normalizeReview(
        APP,
        raw(
          "shaped",
          {
            ...kept,
            text: "Body",
            originalText: "",
            reviewerLanguage: "",
            appVersionName: "",
            appVersionCode: 1.5,
            androidOsVersion: "34",
            thumbsUpCount: "4",
            device: "",
            deviceMetadata: { productName: "" },
          },
          [],
          "",
        ),
      ),
    ).toMatchObject({
      author: null,
      title: null,
      body: "Body",
      originalBody: null,
      language: null,
      appVersionName: null,
      appVersionCode: null,
      osVersion: null,
      device: null,
      thumbsUp: 0,
    });
  });

  it("stores a developer reply, with modifiedAt 0 when its timestamp is unreadable", () => {
    expect(
      normalizeReview(
        APP,
        raw("reply-missing-time", kept, [
          { developerComment: { text: "Noted\tline" } },
        ]),
      ),
    ).toMatchObject({
      developerReply: { text: "Noted\tline", modifiedAt: 0 },
    });
    expect(
      normalizeReview(
        APP,
        raw("reply-bad-time", kept, [
          {
            developerComment: {
              text: "Noted",
              lastModified: { seconds: "soon" },
            },
          },
        ]),
      ),
    ).toMatchObject({ developerReply: { text: "Noted", modifiedAt: 0 } });
    expect(
      normalizeReview(
        APP,
        raw("reply-empty", kept, [
          { developerComment: { text: "", lastModified: { seconds: "99" } } },
        ]),
      ),
    ).toMatchObject({ developerReply: null });
  });

  it("keeps a review whose text is missing, with an empty body", () => {
    expect(
      normalizeReview(
        APP,
        raw("no-text", {
          lastModified: { seconds: "15" },
          starRating: 4,
        }),
      ),
    ).toMatchObject({ title: null, body: "", rating: 4, modifiedAt: 15 });
  });

  it("skips a rating that is not an integer from 1 to 5", () => {
    expect(reason(fixtureReview(malformed, "review-rating-0"))).toBe("rating");
    expect(reason(fixtureReview(malformed, "review-rating-6"))).toBe("rating");
    expect(reason(raw("fraction", { ...kept, starRating: 2.5 }))).toBe(
      "rating",
    );
    expect(
      reason(raw("missing-rating", { ...kept, starRating: undefined })),
    ).toBe("rating");
    expect(reason(raw("string-rating", { ...kept, starRating: "5" }))).toBe(
      "rating",
    );
    expect(reason({ reviewId: "no-comments" } as ListedReview)).toBe("rating");
  });

  it("skips a lastModified that is not a canonical safe-integer string", () => {
    expect(reason(fixtureReview(malformed, "review-no-modified"))).toBe(
      "last_modified",
    );
    for (const seconds of [
      "1.5",
      "nope",
      "",
      "01",
      "1e2",
      "9007199254740993",
    ]) {
      expect(
        reason(
          raw(`seconds-${seconds}`, { ...kept, lastModified: { seconds } }),
        ),
      ).toBe("last_modified");
    }
    expect(
      reason(
        raw("numeric-seconds", { ...kept, lastModified: { seconds: 10 } }),
      ),
    ).toBe("last_modified");
    expect(reason(raw("both", { text: "Hi", starRating: 0 }))).toBe("rating");
  });
});

function review(overrides: Partial<Review> & Pick<Review, "reviewId">): Review {
  return {
    store: "play",
    appId: APP,
    author: null,
    rating: 5,
    title: null,
    body: "",
    originalBody: null,
    language: null,
    appVersionName: null,
    appVersionCode: null,
    osVersion: null,
    device: null,
    thumbsUp: 0,
    modifiedAt: 0,
    developerReply: null,
    ...overrides,
  };
}

function reason(entry: ListedReview): SkipReason | "kept" {
  const result = normalizeReview(APP, entry);
  return "reason" in result ? result.reason : "kept";
}

function fixtureReview(
  page: { reviews: { reviewId: string }[] },
  reviewId: string,
): ListedReview {
  const found = page.reviews.find((entry) => entry.reviewId === reviewId);
  if (!found) throw new Error(`missing ${reviewId}`);
  return found as unknown as ListedReview;
}

function raw(
  reviewId: string,
  user: Record<string, unknown>,
  extras: Record<string, unknown>[] = [],
  authorName?: unknown,
): ListedReview {
  return {
    reviewId,
    ...(authorName === undefined ? {} : { authorName }),
    comments: [{ userComment: user }, ...extras],
  } as unknown as ListedReview;
}
