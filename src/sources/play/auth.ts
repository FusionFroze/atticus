import { bytesToBase64Url, utf8ToBase64Url } from "../../lib/base64url";
import type { Budget } from "../../lib/budget";
import { log } from "../../lib/log";
import { pemToPkcs8 } from "../../lib/pem";
import { isRecord } from "../../lib/record";
import type { SourceFailure } from "../types";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TOKEN_LIFETIME_SECONDS = 60 * 60;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type GoogleCredentials = {
  clientEmail: string;
  privateKeyPem: string;
};

export type AccessTokenResult =
  | { ok: true; token: string }
  | { ok: false; failure: SourceFailure };

type CachedToken = {
  clientEmail: string;
  token: string;
  expiresAtMs: number;
};

// Keyed by client_email only (V26). Not written to D1: a live access token is a credential.
let cached: CachedToken | null = null;

export function clearTokenCache(): void {
  cached = null;
}

export async function signServiceAccountJwt(
  credentials: GoogleCredentials,
  nowSeconds: number,
): Promise<string> {
  const header = utf8ToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = utf8ToBase64Url(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(credentials.privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function getAccessToken(
  credentials: GoogleCredentials,
  budget: Budget,
  nowMs: number = Date.now(),
): Promise<AccessTokenResult> {
  if (
    cached !== null &&
    cached.clientEmail === credentials.clientEmail &&
    nowMs < cached.expiresAtMs - REFRESH_SKEW_MS
  ) {
    return { ok: true, token: cached.token };
  }

  if (!budget.take()) {
    return { ok: false, failure: { kind: "budget" } };
  }

  let assertion: string;
  try {
    assertion = await signServiceAccountJwt(
      credentials,
      Math.floor(nowMs / 1000),
    );
  } catch {
    return { ok: false, failure: { kind: "auth" } };
  }

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
  } catch {
    return { ok: false, failure: { kind: "auth" } };
  }

  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, failure: { kind: "auth" } };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, failure: { kind: "auth" } };
  }

  if (
    !isRecord(body) ||
    typeof body.access_token !== "string" ||
    body.access_token === ""
  ) {
    return { ok: false, failure: { kind: "auth" } };
  }

  const expiresIn =
    typeof body.expires_in === "number"
      ? body.expires_in
      : TOKEN_LIFETIME_SECONDS;
  cached = {
    clientEmail: credentials.clientEmail,
    token: body.access_token,
    expiresAtMs: nowMs + expiresIn * 1000,
  };
  log("token_refreshed");
  return { ok: true, token: body.access_token };
}
