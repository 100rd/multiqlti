/**
 * Crypto-safe UUID with a fallback for NON-secure contexts.
 *
 * `crypto.randomUUID()` only exists in a secure context (HTTPS or localhost).
 * When the app is opened over plain HTTP on a LAN IP (e.g. http://192.168.x.x),
 * `crypto.randomUUID` is undefined and calling it throws
 * "crypto.randomUUID is not a function". This helper uses the native impl when
 * available and otherwise generates an RFC-4122 v4 UUID via Math.random().
 */
export function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
