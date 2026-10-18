import { base64ToBytes } from "./base64url";

const BEGIN = "-----BEGIN PRIVATE KEY-----";
const END = "-----END PRIVATE KEY-----";

// WebCrypto importKey("pkcs8") accepts this header only, which is what Google's JSON key uses.
export function isPkcs8Pem(pem: string): boolean {
  const trimmed = pem.trim();
  return trimmed.includes(BEGIN) && trimmed.includes(END);
}

export function pemToPkcs8(pem: string): Uint8Array {
  const trimmed = pem.trim();
  const start = trimmed.indexOf(BEGIN);
  const end = trimmed.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("PEM is not a PKCS#8 private key");
  }
  const body = trimmed.slice(start + BEGIN.length, end).replaceAll(/\s/g, "");
  return base64ToBytes(body);
}
