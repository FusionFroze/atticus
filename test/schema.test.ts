import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("local D1", () => {
  it("applies the four tables and the two indexes", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "d1_migrations",
      "messages",
      "outbox",
      "reviews",
      "state",
    ]);

    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('messages_review', 'outbox_pending') ORDER BY name",
    ).all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toEqual([
      "messages_review",
      "outbox_pending",
    ]);

    const reviews = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reviews'",
    ).first<{ sql: string }>();
    expect(reviews?.sql ?? "").not.toContain("AUTOINCREMENT");
  });
});
