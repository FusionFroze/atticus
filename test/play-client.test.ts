import { afterEach, describe, expect, it } from "vitest";
import { createBudget } from "../src/lib/budget";
import { listReviews, reply } from "../src/sources/play/client";
import page1 from "./fixtures/play/page-1.json";

const PACKAGE = "com.fusionfroze.Lune";
const TOKEN = "ya29.test-token";

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe("listReviews", () => {
  it("requests one page of 100 and stops when there is no next token", async () => {
    const calls = installFetch(() => Response.json(onePage()));
    const result = await listReviews(input(null));

    expect(result).toEqual({
      ok: true,
      truncated: false,
      reviews: [{ reviewId: "review-1", authorName: "Avery Quinn" }],
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe(
      `/androidpublisher/v3/applications/${PACKAGE}/reviews`,
    );
    expect(url.searchParams.get("maxResults")).toBe("100");
    expect(url.searchParams.get("translationLanguage")).toBeNull();
    expect(url.searchParams.get("token")).toBeNull();
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("follows page tokens and sends translationLanguage on every page", async () => {
    const pages = [page("a", "t2"), page("b", "t3"), page("c", null)];
    const calls = installFetch(() => Response.json(pages.shift()));
    const result = await listReviews(input("en_GB"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(false);
    expect(result.reviews.map((review) => review.reviewId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(
      calls.map((call) => new URL(call.url).searchParams.get("token")),
    ).toEqual([null, "t2", "t3"]);
    expect(
      calls.every(
        (call) =>
          new URL(call.url).searchParams.get("translationLanguage") === "en_GB",
      ),
    ).toBe(true);
  });

  it("stops after five pages and reports the cut-off", async () => {
    const calls = installFetch(() => Response.json(page("id", "more")));
    const result = await listReviews(input(null));
    expect(calls).toHaveLength(5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.reviews).toHaveLength(5);
  });

  it("reads the checked-in page fixture", async () => {
    const calls = installFetch((request) => {
      const token = new URL(request.url).searchParams.get("token");
      if (token === null) return Response.json(page1);
      return Response.json({ reviews: [] });
    });
    const result = await listReviews(input("en"));
    const fixtureIds = page1.reviews.map((review) => review.reviewId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reviews.map((review) => review.reviewId)).toEqual(fixtureIds);
    expect(calls).toHaveLength(page1.tokenPagination?.nextPageToken ? 2 : 1);
  });

  it("maps HTTP statuses, a network error and a malformed page", async () => {
    await expectStatus(401, { kind: "auth" });
    await expectStatus(403, { kind: "forbidden" });
    await expectStatus(429, { kind: "rate_limited" });
    await expectStatus(500, { kind: "unavailable", status: 500 });
    await expectStatus(400, { kind: "invalid", detail: "bad request" });

    installFetch(() => {
      throw new TypeError("network down");
    });
    expect(await listReviews(input(null))).toEqual({
      ok: false,
      failure: { kind: "unavailable", status: 0 },
    });

    installFetch(() => new Response("not-json", { status: 200 }));
    expect(await listReviews(input(null))).toEqual({
      ok: false,
      failure: { kind: "invalid", detail: "malformed response" },
    });
  });

  it("does not fetch when the budget is already spent", async () => {
    const calls = installFetch(() => Response.json(onePage()));
    const result = await listReviews({
      ...input(null),
      budget: createBudget(0, 0),
    });
    expect(result).toEqual({ ok: false, failure: { kind: "budget" } });
    expect(calls).toHaveLength(0);
  });

  it("stops on the page the budget cannot pay for", async () => {
    const calls = installFetch(() => Response.json(page("id", "more")));
    const result = await listReviews({
      ...input(null),
      budget: createBudget(0, 2),
    });
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ ok: false, failure: { kind: "budget" } });
  });
});

describe("reply", () => {
  it("posts replyText and maps the same statuses", async () => {
    const calls = installFetch(() =>
      Response.json({ result: { replyText: "Thanks" } }),
    );
    const result = await reply({
      packageName: PACKAGE,
      reviewId: "review/1",
      text: "Thanks",
      accessToken: TOKEN,
      budget: createBudget(0),
    });
    expect(result).toEqual({ ok: true });
    const request = calls[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toContain(`/reviews/review%2F1:reply`);
    expect(await request?.text()).toBe('{"replyText":"Thanks"}');

    await expectReplyStatus(400, {
      kind: "invalid",
      detail: "too long or empty",
    });
    await expectReplyStatus(404, { kind: "not_found" });
    await expectReplyStatus(401, { kind: "auth" });
    await expectReplyStatus(403, { kind: "forbidden" });
    await expectReplyStatus(429, { kind: "rate_limited" });
    await expectReplyStatus(502, { kind: "unavailable", status: 502 });

    installFetch(() => {
      throw new TypeError("network down");
    });
    expect(await reply(replyInput())).toEqual({
      ok: false,
      failure: { kind: "unavailable", status: 0 },
    });

    const spent = installFetch(() => Response.json({}));
    expect(
      await reply({ ...replyInput(), budget: createBudget(0, 0) }),
    ).toEqual({
      ok: false,
      failure: { kind: "budget" },
    });
    expect(spent).toHaveLength(0);
  });
});

function input(translationLanguage: string | null) {
  return {
    packageName: PACKAGE,
    translationLanguage,
    accessToken: TOKEN,
    budget: createBudget(0),
  };
}

function replyInput() {
  return {
    packageName: PACKAGE,
    reviewId: "review-1",
    text: "Thanks",
    accessToken: TOKEN,
    budget: createBudget(0),
  };
}

function onePage() {
  return { reviews: [{ reviewId: "review-1", authorName: "Avery Quinn" }] };
}

function page(reviewId: string, next: string | null) {
  return {
    reviews: [{ reviewId }],
    ...(next === null ? {} : { tokenPagination: { nextPageToken: next } }),
  };
}

function installFetch(
  handler: (request: Request) => Response | Promise<Response>,
): Request[] {
  restoreFetch?.();
  const calls: Request[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    return handler(request);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = previous;
  };
  return calls;
}

async function expectStatus(
  status: number,
  failure: { kind: string; status?: number; detail?: string },
) {
  installFetch(() => new Response("error-body-should-not-matter", { status }));
  expect(await listReviews(input(null))).toEqual({ ok: false, failure });
}

async function expectReplyStatus(
  status: number,
  failure: { kind: string; status?: number; detail?: string },
) {
  installFetch(() => new Response("error-body-should-not-matter", { status }));
  expect(await reply(replyInput())).toEqual({ ok: false, failure });
}
