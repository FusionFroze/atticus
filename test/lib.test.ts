import { describe, expect, it } from "vitest";
import { bytesToBase64Url, utf8ToBase64Url } from "../src/lib/base64url";
import {
  createBudget,
  EXTERNAL_CALL_LIMIT,
  SENDER_WALL_MS,
} from "../src/lib/budget";
import { pemToPkcs8 } from "../src/lib/pem";

describe("budget", () => {
  it("allows 45 external calls and then stops", () => {
    const now = 1_700_000_000_000;
    const budget = createBudget(now);
    expect(budget.limit).toBe(EXTERNAL_CALL_LIMIT);
    expect(budget.deadline).toBe(now + SENDER_WALL_MS);
    for (let i = 0; i < EXTERNAL_CALL_LIMIT; i++)
      expect(budget.take()).toBe(true);
    expect(budget.remaining()).toBe(0);
    expect(budget.take()).toBe(false);
  });
});

describe("base64url", () => {
  it("encodes without padding and keeps bytes above 127", () => {
    expect(utf8ToBase64Url("hello")).toBe("aGVsbG8");
    const bytes = new Uint8Array([0, 255, 1]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });
});

describe("pem", () => {
  it("rejects a key that is not PKCS#8 and does not echo it", () => {
    const marker = "UNIQUE_PEM_MARKER_z9Q";
    expect(() => pemToPkcs8(marker)).toThrow("PEM is not a PKCS#8 private key");
    const pkcs1 = `-----BEGIN RSA PRIVATE KEY-----\n${marker}\n-----END RSA PRIVATE KEY-----`;
    expect(() => pemToPkcs8(pkcs1)).toThrow("PEM is not a PKCS#8 private key");
    expect(() => pemToPkcs8(pkcs1)).not.toThrow(marker);
  });
});
