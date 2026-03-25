import crypto from "crypto";
import type { FederationMessage } from "./types.js";

/**
 * Sign a hello handshake message using HMAC-SHA256.
 * The signed payload is `instanceId:timestamp`.
 */
export function signMessage(
  secret: string,
  instanceId: string,
  timestamp: number,
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${instanceId}:${timestamp}`)
    .digest("hex");
}

/**
 * Verify a hello handshake HMAC using constant-time comparison.
 */
export function verifyMessage(
  secret: string,
  instanceId: string,
  timestamp: number,
  hmac: string,
): boolean {
  const expected = signMessage(secret, instanceId, timestamp);
  if (expected.length !== hmac.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac));
}

/**
 * Sign a federation message envelope using HMAC-SHA256.
 * The signed payload is `type:from:correlationId:timestamp`.
 */
export function signEnvelope(
  secret: string,
  msg: Omit<FederationMessage, "hmac">,
): string {
  const data = `${msg.type}:${msg.from}:${msg.correlationId}:${msg.timestamp}`;
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

/**
 * Verify a federation message envelope HMAC using constant-time comparison.
 */
export function verifyEnvelope(
  secret: string,
  msg: FederationMessage,
): boolean {
  const expected = signEnvelope(secret, msg);
  if (expected.length !== msg.hmac.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(msg.hmac));
}
