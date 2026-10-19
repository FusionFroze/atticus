import { afterEach, describe, expect, it } from "vitest";
import {
  clearKeyCache,
  verifyDiscordRequest,
} from "../src/notifiers/discord/verify";

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const BODY = '{"type":1}';

afterEach(() => {
  clearKeyCache();
});

describe("Discord signature", () => {
  it("accepts a body signed by the matching key", async () => {
    const key = await generateKey();
    const timestamp = String(NOW_SECONDS);
    const result = await verifyDiscordRequest({
      publicKey: key.publicKey,
      timestamp,
      signature: await sign(key.privateKey, timestamp, BODY),
      body: BODY,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts a signed body that is not JSON", async () => {
    const key = await generateKey();
    const timestamp = String(NOW_SECONDS);
    const body = "{";
    const result = await verifyDiscordRequest({
      publicKey: key.publicKey,
      timestamp,
      signature: await sign(key.privateKey, timestamp, body),
      body,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a tampered body", async () => {
    const key = await generateKey();
    const timestamp = String(NOW_SECONDS);
    const result = await verifyDiscordRequest({
      publicKey: key.publicKey,
      timestamp,
      signature: await sign(key.privateKey, timestamp, BODY),
      body: '{"type":2}',
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects a tampered timestamp", async () => {
    const key = await generateKey();
    const timestamp = String(NOW_SECONDS);
    const result = await verifyDiscordRequest({
      publicKey: key.publicKey,
      timestamp: String(NOW_SECONDS + 1),
      signature: await sign(key.privateKey, timestamp, BODY),
      body: BODY,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects a signature from a different key", async () => {
    const key = await generateKey();
    const other = await generateKey();
    const timestamp = String(NOW_SECONDS);
    const result = await verifyDiscordRequest({
      publicKey: other.publicKey,
      timestamp,
      signature: await sign(key.privateKey, timestamp, BODY),
      body: BODY,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects missing headers", async () => {
    const key = await generateKey();
    const timestamp = String(NOW_SECONDS);
    const signature = await sign(key.privateKey, timestamp, BODY);
    expect(
      await verifyDiscordRequest({
        publicKey: key.publicKey,
        timestamp: null,
        signature,
        body: BODY,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reason: "missing" });
    expect(
      await verifyDiscordRequest({
        publicKey: key.publicKey,
        timestamp: "",
        signature,
        body: BODY,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reason: "missing" });
    expect(
      await verifyDiscordRequest({
        publicKey: key.publicKey,
        timestamp,
        signature: null,
        body: BODY,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reason: "missing" });
    expect(
      await verifyDiscordRequest({
        publicKey: key.publicKey,
        timestamp,
        signature: "",
        body: BODY,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects malformed hex", async () => {
    const key = await generateKey();
    const timestamp = String(NOW_SECONDS);
    const signature = await sign(key.privateKey, timestamp, BODY);
    const cases = [
      { publicKey: key.publicKey, signature: "abc" },
      { publicKey: key.publicKey, signature: "zz".repeat(64) },
      { publicKey: key.publicKey, signature: "ab" },
      { publicKey: "ab".repeat(16), signature },
      { publicKey: "gg".repeat(32), signature },
    ];
    for (const entry of cases) {
      expect(
        await verifyDiscordRequest({
          publicKey: entry.publicKey,
          timestamp,
          signature: entry.signature,
          body: BODY,
          nowMs: NOW_MS,
        }),
      ).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("rejects a timestamp more than 5 minutes away", async () => {
    const key = await generateKey();
    for (const seconds of [NOW_SECONDS - 301, NOW_SECONDS + 301]) {
      const timestamp = String(seconds);
      const result = await verifyDiscordRequest({
        publicKey: key.publicKey,
        timestamp,
        signature: await sign(key.privateKey, timestamp, BODY),
        body: BODY,
        nowMs: NOW_MS,
      });
      expect(result).toEqual({ ok: false, reason: "stale" });
    }
  });

  it("accepts a timestamp exactly 5 minutes away", async () => {
    const key = await generateKey();
    for (const seconds of [NOW_SECONDS - 300, NOW_SECONDS + 300]) {
      const timestamp = String(seconds);
      const result = await verifyDiscordRequest({
        publicKey: key.publicKey,
        timestamp,
        signature: await sign(key.privateKey, timestamp, BODY),
        body: BODY,
        nowMs: NOW_MS,
      });
      expect(result).toEqual({ ok: true });
    }
  });

  it("rejects a signed timestamp that is not a whole number of seconds", async () => {
    const key = await generateKey();
    const timestamp = `${NOW_SECONDS}.5`;
    const result = await verifyDiscordRequest({
      publicKey: key.publicKey,
      timestamp,
      signature: await sign(key.privateKey, timestamp, BODY),
      body: BODY,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "stale" });
  });
});

async function generateKey(): Promise<{
  publicKey: string;
  privateKey: CryptoKey;
}> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("expected an Ed25519 key pair");
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error("expected raw public key");
  return {
    publicKey: toHex(new Uint8Array(raw)),
    privateKey: pair.privateKey,
  };
}

async function sign(
  privateKey: CryptoKey,
  timestamp: string,
  body: string,
): Promise<string> {
  const raw = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(timestamp + body),
  );
  if (!(raw instanceof ArrayBuffer)) throw new Error("expected a signature");
  return toHex(new Uint8Array(raw));
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
