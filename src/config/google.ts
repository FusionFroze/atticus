import { isPkcs8Pem } from "../lib/pem";
import { isRecord } from "../lib/record";
import { GOOGLE_SECRET, parseJsonText } from "./text";
import type { Config } from "./types";

export function parseGoogle(
  value: unknown,
  errors: string[],
): Config["google"] | null {
  if (value === undefined || value === "") {
    errors.push(`\`GOOGLE_SERVICE_ACCOUNT_JSON\` is missing. ${GOOGLE_SECRET}`);
    return null;
  }

  const parsed = typeof value === "string" ? parseJsonText(value) : value;
  if (typeof value === "string" && parsed === undefined) {
    errors.push(
      `\`GOOGLE_SERVICE_ACCOUNT_JSON\` is not valid JSON. ${GOOGLE_SECRET}`,
    );
    return null;
  }
  if (!isRecord(parsed)) {
    errors.push(
      `\`GOOGLE_SERVICE_ACCOUNT_JSON\` must be a JSON object. ${GOOGLE_SECRET}`,
    );
    return null;
  }

  const clientEmail = parsed.client_email;
  const privateKey = parsed.private_key;
  let ok = true;
  if (typeof clientEmail !== "string" || clientEmail.trim() === "") {
    errors.push(
      `\`GOOGLE_SERVICE_ACCOUNT_JSON\` is missing \`client_email\`. ${GOOGLE_SECRET}`,
    );
    ok = false;
  }
  if (typeof privateKey !== "string" || privateKey.trim() === "") {
    errors.push(
      `\`GOOGLE_SERVICE_ACCOUNT_JSON\` is missing \`private_key\`. ${GOOGLE_SECRET}`,
    );
    ok = false;
  } else if (!isPkcs8Pem(privateKey)) {
    errors.push(
      `\`GOOGLE_SERVICE_ACCOUNT_JSON\` field \`private_key\` must be a PKCS#8 PEM private key. ${GOOGLE_SECRET}`,
    );
    ok = false;
  }

  if (!ok || typeof clientEmail !== "string" || typeof privateKey !== "string")
    return null;
  return { clientEmail: clientEmail.trim(), privateKeyPem: privateKey };
}
