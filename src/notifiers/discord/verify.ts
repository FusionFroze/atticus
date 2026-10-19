// Ed25519 over `timestamp + raw body` (V51). The public key is imported once per isolate.
// A timestamp more than 5 minutes off the Worker clock is rejected after the signature matches.

const REPLAY_WINDOW_SECONDS = 300;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

const keys = new Map<string, CryptoKey>();

export type VerifyFailure = "missing" | "malformed" | "signature" | "stale";

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

export function clearKeyCache(): void {
  keys.clear();
}

export async function verifyDiscordRequest(input: {
  publicKey: string;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowMs: number;
}): Promise<VerifyResult> {
  if (input.timestamp === null || input.timestamp === "") {
    return { ok: false, reason: "missing" };
  }
  if (input.signature === null || input.signature === "") {
    return { ok: false, reason: "missing" };
  }

  const signature = decodeHex(input.signature);
  const publicKey = decodeHex(input.publicKey);
  if (
    signature === null ||
    signature.length !== SIGNATURE_BYTES ||
    publicKey === null ||
    publicKey.length !== PUBLIC_KEY_BYTES
  ) {
    return { ok: false, reason: "malformed" };
  }

  const key = await importPublicKey(input.publicKey, publicKey);
  if (key === null) return { ok: false, reason: "malformed" };

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature,
      new TextEncoder().encode(input.timestamp + input.body),
    );
  } catch {
    return { ok: false, reason: "signature" };
  }
  if (!valid) return { ok: false, reason: "signature" };
  if (!fresh(input.timestamp, input.nowMs)) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true };
}

function fresh(timestamp: string, nowMs: number): boolean {
  if (!/^[0-9]+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  return Math.abs(nowSeconds - seconds) <= REPLAY_WINDOW_SECONDS;
}

async function importPublicKey(
  hex: string,
  raw: Uint8Array,
): Promise<CryptoKey | null> {
  const cached = keys.get(hex);
  if (cached !== undefined) return cached;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    keys.set(hex, key);
    return key;
  } catch {
    return null;
  }
}

function decodeHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isInteger(byte)) return null;
    bytes[index] = byte;
  }
  return bytes;
}
