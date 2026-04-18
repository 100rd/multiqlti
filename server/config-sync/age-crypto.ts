/**
 * age-crypto.ts — age-style secret encryption for config-sync
 *
 * Threat model: see docs/config-sync/secrets.md
 *
 * Design:
 *   - Each machine has an X25519 key pair (private: ~/.config/mqlti/age-keys.txt).
 *   - A file is encrypted with a random 256-bit symmetric key (AES-256-GCM).
 *   - That symmetric key is sealed for every recipient using X25519 ECDH +
 *     HKDF-SHA-256 (key derivation) + AES-256-GCM (key wrapping).
 *   - The ciphertext file is self-describing: recipients + wrapped keys are
 *     stored in a JSON header, followed by the payload ciphertext.
 *
 * Wire format (.secret file):
 *   {
 *     "version": 1,
 *     "recipients": [
 *       {
 *         "publicKey":     "<hex 32-byte recipient X25519 public key>",
 *         "ephemeralKey":  "<hex 32-byte ephemeral X25519 public key>",
 *         "wrappedKey":    "<hex 12+32+16 = 60-byte: iv | ciphertext | tag>",
 *         "name":          "<optional human-readable label>"
 *       }, ...
 *     ],
 *     "payload": {
 *       "iv":         "<hex 12-byte nonce>",
 *       "ciphertext": "<hex>",
 *       "tag":        "<hex 16-byte auth tag>"
 *     }
 *   }
 */

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Current wire format version. Increment on breaking changes. */
const FORMAT_VERSION = 1 as const;

/** Where the private key lives on each machine. */
const DEFAULT_KEY_FILE = path.join(
  os.homedir(),
  ".config",
  "mqlti",
  "age-keys.txt",
);

/** HKDF info string — prevents cross-protocol key reuse. */
const HKDF_INFO = Buffer.from("mqlti-age-crypto-v1");

/** AES key size in bytes. */
const KEY_BYTES = 32;

/** AES-GCM IV size in bytes. */
const IV_BYTES = 12;

/** AES-GCM authentication tag size in bytes. */
const TAG_BYTES = 16;

/**
 * Fixed 16-byte PKCS#8 DER header for X25519 private keys.
 *
 * Structure (ASN.1):
 *   SEQUENCE {
 *     INTEGER 0                          (version)
 *     SEQUENCE { OID 1.3.101.110 }       (X25519 algorithm ID)
 *     OCTET STRING {
 *       OCTET STRING (length 32)         (raw key — inner wrapping)
 *     }
 *   }
 *
 * hex: 302e020100300506032b656e04220420
 * The 32 raw key bytes follow immediately after this header.
 */
const PKCS8_X25519_HEADER = Buffer.from("302e020100300506032b656e04220420", "hex");

/**
 * Fixed 12-byte SubjectPublicKeyInfo (SPKI) DER header for X25519 public keys.
 *
 * Structure:
 *   SEQUENCE {
 *     SEQUENCE { OID 1.3.101.110 }
 *     BIT STRING (length 32, no unused bits)
 *   }
 *
 * hex: 302a300506032b656e032100
 * The 32 raw key bytes follow immediately after this header.
 */
const SPKI_X25519_HEADER = Buffer.from("302a300506032b656e032100", "hex");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgeKeyPair {
  /** X25519 private key (never committed to git). */
  privateKey: crypto.KeyObject;
  /** X25519 public key (safe to publish). */
  publicKey: crypto.KeyObject;
  /** Public key as lowercase hex string (32 bytes). */
  publicKeyHex: string;
  /** Optional human-readable machine label. */
  name?: string;
}

export interface Recipient {
  /** Recipient X25519 public key (hex). */
  publicKey: string;
  /** Ephemeral X25519 public key used for this recipient (hex). */
  ephemeralKey: string;
  /** AES-GCM-encrypted symmetric key: iv(12) | ciphertext(32) | tag(16) hex. */
  wrappedKey: string;
  /** Optional human-readable label (e.g., "laptop-igor"). */
  name?: string;
}

interface Payload {
  /** AES-GCM nonce (hex, 12 bytes). */
  iv: string;
  /** AES-GCM ciphertext (hex). */
  ciphertext: string;
  /** AES-GCM authentication tag (hex, 16 bytes). */
  tag: string;
}

export interface EncryptedFile {
  version: typeof FORMAT_VERSION;
  recipients: Recipient[];
  payload: Payload;
}

/** Public key descriptor stored in the public-keys/ directory. */
export interface PublicKeyRecord {
  version: typeof FORMAT_VERSION;
  publicKey: string;
  name: string;
  createdAt: string;
}

// ─── Key generation ───────────────────────────────────────────────────────────

/**
 * Generate a new X25519 key pair.
 *
 * @param name Optional human-readable label for this machine.
 * @returns AgeKeyPair with cryptographic objects + hex-encoded public key.
 */
export function generateKeyPair(name?: string): AgeKeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  const publicKeyHex = rawPublicKeyBytes(publicKey).toString("hex");
  return { privateKey, publicKey, publicKeyHex, name };
}

/**
 * Serialize a key pair to the age-keys.txt format.
 *
 * Format (each line):
 *   # public-key: <hex>
 *   # name: <label>     (omitted when name is absent)
 *   private: <hex>
 */
export function serializeKeyPair(kp: AgeKeyPair): string {
  const lines: string[] = [
    `# public-key: ${kp.publicKeyHex}`,
  ];
  if (kp.name) lines.push(`# name: ${kp.name}`);
  lines.push(`private: ${rawPrivateKeyBytes(kp.privateKey).toString("hex")}`);
  return lines.join("\n") + "\n";
}

/**
 * Deserialize a key pair from age-keys.txt content.
 *
 * @throws Error if the content is malformed or the private key is invalid.
 */
export function deserializeKeyPair(content: string): AgeKeyPair {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let privateHex: string | undefined;
  let name: string | undefined;

  for (const line of lines) {
    if (line.startsWith("# name:")) {
      name = line.slice("# name:".length).trim();
    } else if (line.startsWith("private:")) {
      privateHex = line.slice("private:".length).trim();
    }
  }

  if (!privateHex) {
    throw new Error("age-keys.txt: missing 'private:' line");
  }

  const rawKeyBytes = Buffer.from(privateHex, "hex");
  if (rawKeyBytes.length !== 32) {
    throw new Error(
      `age-keys.txt: expected 32-byte private key, got ${rawKeyBytes.length}`,
    );
  }

  const privateKey = privateKeyFromRaw(rawKeyBytes);
  const publicKey = crypto.createPublicKey(privateKey);
  const publicKeyHex = rawPublicKeyBytes(publicKey).toString("hex");

  return { privateKey, publicKey, publicKeyHex, name };
}

/**
 * Load (or create) the machine key pair from the default key file.
 *
 * If the file does not exist, generates a new key pair, persists it, and
 * returns it.  The directory is created with mode 0o700 so only the owner can
 * read it.
 *
 * @param keyFile Path to the key file (defaults to ~/.config/mqlti/age-keys.txt).
 * @param name    Human-readable label for auto-generated keys.
 */
export async function loadOrCreateKeyPair(
  keyFile: string = DEFAULT_KEY_FILE,
  name?: string,
): Promise<AgeKeyPair> {
  try {
    const content = await fs.readFile(keyFile, "utf-8");
    return deserializeKeyPair(content);
  } catch (err: unknown) {
    // File doesn't exist → generate a new pair
    if (isNodeError(err) && err.code === "ENOENT") {
      const kp = generateKeyPair(name ?? hostnameLabel());
      await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(keyFile, serializeKeyPair(kp), { mode: 0o600 });
      return kp;
    }
    throw err;
  }
}

// ─── Public key record I/O ────────────────────────────────────────────────────

/**
 * Build a PublicKeyRecord from a key pair.
 * This is what gets committed to the public-keys/ directory in the config repo.
 */
export function buildPublicKeyRecord(kp: AgeKeyPair): PublicKeyRecord {
  return {
    version: FORMAT_VERSION,
    publicKey: kp.publicKeyHex,
    name: kp.name ?? hostnameLabel(),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Parse a PublicKeyRecord from JSON content.
 * @throws Error on missing/invalid fields.
 */
export function parsePublicKeyRecord(json: string): PublicKeyRecord {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error("Public key record is not valid JSON");
  }

  assertPublicKeyRecord(obj);
  return obj;
}

// ─── Encryption ───────────────────────────────────────────────────────────────

/**
 * Encrypt plaintext for one or more recipients.
 *
 * @param plaintext  The secret bytes to encrypt.
 * @param recipients Array of X25519 public key hex strings (+ optional names).
 * @returns Parsed EncryptedFile ready to be JSON-serialized and saved.
 * @throws Error if recipients list is empty.
 */
export function encrypt(
  plaintext: Buffer,
  recipients: Array<{ publicKey: string; name?: string }>,
): EncryptedFile {
  if (recipients.length === 0) {
    throw new Error("encrypt: at least one recipient required");
  }

  // 1. Generate a random 256-bit symmetric key for the payload.
  const symmetricKey = crypto.randomBytes(KEY_BYTES);

  // 2. Encrypt the payload with that symmetric key.
  const payloadIv = crypto.randomBytes(IV_BYTES);
  const payloadCipher = crypto.createCipheriv("aes-256-gcm", symmetricKey, payloadIv);
  const payloadCt = Buffer.concat([
    payloadCipher.update(plaintext),
    payloadCipher.final(),
  ]);
  const payloadTag = payloadCipher.getAuthTag();

  // 3. For each recipient, wrap the symmetric key using ECDH + HKDF + AES-GCM.
  const encryptedRecipients: Recipient[] = recipients.map(({ publicKey, name }) => {
    const recipientPublicKey = publicKeyFromHex(publicKey);

    // Ephemeral key pair for this recipient.
    const { privateKey: ephemeralPriv, publicKey: ephemeralPub } =
      crypto.generateKeyPairSync("x25519");

    // ECDH shared secret: ephemeral_private * recipient_public
    const sharedSecret = crypto.diffieHellman({
      privateKey: ephemeralPriv,
      publicKey: recipientPublicKey,
    });

    // HKDF to derive a wrapping key from the shared secret.
    const salt = Buffer.concat([
      rawPublicKeyBytes(ephemeralPub),
      Buffer.from(publicKey, "hex"),
    ]);
    const wrappingKey = hkdf(sharedSecret, salt, HKDF_INFO, KEY_BYTES);

    // Wrap the symmetric key with the derived wrapping key.
    const wrapIv = crypto.randomBytes(IV_BYTES);
    const wrapCipher = crypto.createCipheriv("aes-256-gcm", wrappingKey, wrapIv);
    const wrapCt = Buffer.concat([
      wrapCipher.update(symmetricKey),
      wrapCipher.final(),
    ]);
    const wrapTag = wrapCipher.getAuthTag();

    const wrappedKey = Buffer.concat([wrapIv, wrapCt, wrapTag]).toString("hex");

    return {
      publicKey,
      ephemeralKey: rawPublicKeyBytes(ephemeralPub).toString("hex"),
      wrappedKey,
      ...(name !== undefined ? { name } : {}),
    };
  });

  return {
    version: FORMAT_VERSION,
    recipients: encryptedRecipients,
    payload: {
      iv: payloadIv.toString("hex"),
      ciphertext: payloadCt.toString("hex"),
      tag: payloadTag.toString("hex"),
    },
  };
}

// ─── Decryption ───────────────────────────────────────────────────────────────

/**
 * Decrypt an EncryptedFile using the caller's private key.
 *
 * Iterates over recipients to find one matching the private key's public key,
 * then unwraps the symmetric key and decrypts the payload.
 *
 * @param encrypted  Parsed EncryptedFile.
 * @param privateKey Caller's X25519 private key.
 * @returns Decrypted plaintext bytes.
 * @throws Error if no matching recipient found, or authentication fails.
 */
export function decrypt(encrypted: EncryptedFile, privateKey: crypto.KeyObject): Buffer {
  if (encrypted.version !== FORMAT_VERSION) {
    throw new Error(
      `Unsupported encrypted file version: ${encrypted.version}`,
    );
  }

  const myPublicKey = crypto.createPublicKey(privateKey);
  const myPublicKeyHex = rawPublicKeyBytes(myPublicKey).toString("hex");

  // Find our recipient entry.
  const recipient = encrypted.recipients.find(
    (r) => r.publicKey === myPublicKeyHex,
  );

  if (!recipient) {
    throw new Error(
      "decrypt: this key is not a recipient of this file",
    );
  }

  // Reconstruct the ECDH shared secret: recipient_private * ephemeral_public
  const ephemeralPublicKey = publicKeyFromHex(recipient.ephemeralKey);
  const sharedSecret = crypto.diffieHellman({
    privateKey,
    publicKey: ephemeralPublicKey,
  });

  // Derive the wrapping key (same HKDF parameters as during encryption).
  const salt = Buffer.concat([
    Buffer.from(recipient.ephemeralKey, "hex"),
    Buffer.from(myPublicKeyHex, "hex"),
  ]);
  const wrappingKey = hkdf(sharedSecret, salt, HKDF_INFO, KEY_BYTES);

  // Unwrap the symmetric key.
  const wrappedKeyBuf = Buffer.from(recipient.wrappedKey, "hex");
  if (wrappedKeyBuf.length !== IV_BYTES + KEY_BYTES + TAG_BYTES) {
    throw new Error("decrypt: malformed wrapped key length");
  }
  const wrapIv = wrappedKeyBuf.subarray(0, IV_BYTES);
  const wrapCt = wrappedKeyBuf.subarray(IV_BYTES, IV_BYTES + KEY_BYTES);
  const wrapTag = wrappedKeyBuf.subarray(IV_BYTES + KEY_BYTES);

  const wrapDecipher = crypto.createDecipheriv("aes-256-gcm", wrappingKey, wrapIv);
  wrapDecipher.setAuthTag(wrapTag);

  let symmetricKey: Buffer;
  try {
    symmetricKey = Buffer.concat([
      wrapDecipher.update(wrapCt),
      wrapDecipher.final(),
    ]);
  } catch {
    throw new Error("decrypt: key unwrapping failed — authentication error");
  }

  // Decrypt the payload.
  const payloadIv = Buffer.from(encrypted.payload.iv, "hex");
  const payloadCt = Buffer.from(encrypted.payload.ciphertext, "hex");
  const payloadTag = Buffer.from(encrypted.payload.tag, "hex");

  const payloadDecipher = crypto.createDecipheriv(
    "aes-256-gcm",
    symmetricKey,
    payloadIv,
  );
  payloadDecipher.setAuthTag(payloadTag);

  try {
    return Buffer.concat([
      payloadDecipher.update(payloadCt),
      payloadDecipher.final(),
    ]);
  } catch {
    throw new Error("decrypt: payload authentication failed");
  }
}

// ─── Serialisation helpers ────────────────────────────────────────────────────

/**
 * Serialize an EncryptedFile to a pretty-printed JSON string.
 */
export function serializeEncryptedFile(ef: EncryptedFile): string {
  return JSON.stringify(ef, null, 2) + "\n";
}

/**
 * Parse and validate an EncryptedFile from JSON content.
 * @throws Error if the content is malformed.
 */
export function parseEncryptedFile(json: string): EncryptedFile {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error("Encrypted file is not valid JSON");
  }

  assertEncryptedFile(obj);
  return obj;
}

// ─── File I/O helpers ─────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext file and write the .secret file next to it.
 *
 * @param sourcePath   Path to the plaintext file (e.g., connections/gitlab-main.yaml).
 * @param recipients   Array of public key records loaded from public-keys/.
 * @param secretPath   Optional output path; defaults to sourcePath + ".secret".
 * @returns Path to the written .secret file.
 */
export async function encryptFile(
  sourcePath: string,
  recipients: Array<{ publicKey: string; name?: string }>,
  secretPath?: string,
): Promise<string> {
  const plaintext = await fs.readFile(sourcePath);
  const encrypted = encrypt(plaintext, recipients);
  const outPath = secretPath ?? sourcePath + ".secret";
  await fs.writeFile(outPath, serializeEncryptedFile(encrypted), "utf-8");
  return outPath;
}

/**
 * Decrypt a .secret file and return the plaintext bytes.
 *
 * @param secretPath  Path to the .secret file.
 * @param privateKey  Caller's X25519 private key.
 * @returns Plaintext bytes.
 */
export async function decryptFile(
  secretPath: string,
  privateKey: crypto.KeyObject,
): Promise<Buffer> {
  const content = await fs.readFile(secretPath, "utf-8");
  const encrypted = parseEncryptedFile(content);
  return decrypt(encrypted, privateKey);
}

/**
 * Re-encrypt all .secret files in a config repo for a new recipient set.
 *
 * Used during key rotation and when a new machine is added.
 *
 * @param secretPaths  Array of .secret file paths to re-encrypt.
 * @param decryptKey   Private key able to decrypt the existing files.
 * @param recipients   New full recipient list.
 * @returns Array of paths that were re-encrypted.
 */
export async function reEncryptAll(
  secretPaths: string[],
  decryptKey: crypto.KeyObject,
  recipients: Array<{ publicKey: string; name?: string }>,
): Promise<string[]> {
  const results: string[] = [];
  for (const secretPath of secretPaths) {
    const plaintext = await decryptFile(secretPath, decryptKey);
    const encrypted = encrypt(plaintext, recipients);
    await fs.writeFile(secretPath, serializeEncryptedFile(encrypted), "utf-8");
    results.push(secretPath);
  }
  return results;
}

/**
 * Read all recipient public key records from a public-keys/ directory.
 *
 * @param publicKeysDir  Path to the public-keys/ directory in the config repo.
 * @returns Array of PublicKeyRecord (skips .gitkeep and non-.json files).
 */
export async function loadPublicKeys(
  publicKeysDir: string,
): Promise<PublicKeyRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(publicKeysDir);
  } catch {
    return [];
  }

  const records: PublicKeyRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(publicKeysDir, entry);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      records.push(parsePublicKeyRecord(content));
    } catch {
      // Skip malformed files; caller can log warnings
    }
  }
  return records;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Extract the raw 32-byte key material from an X25519 public key object.
 *
 * Node's X25519 SPKI DER is: 12-byte header + 32-byte raw key (44 bytes total).
 * The raw key is always the last 32 bytes.
 */
function rawPublicKeyBytes(key: crypto.KeyObject): Buffer {
  const der = key.export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(der.length - 32);
}

/**
 * Extract the raw 32-byte key material from an X25519 private key object.
 *
 * Node's X25519 PKCS#8 DER is: 16-byte header + 32-byte raw key (48 bytes total).
 * The raw key is always the last 32 bytes.
 */
function rawPrivateKeyBytes(key: crypto.KeyObject): Buffer {
  const der = key.export({ type: "pkcs8", format: "der" }) as Buffer;
  return der.subarray(der.length - 32);
}

/**
 * Reconstruct an X25519 private KeyObject from raw 32-byte key material.
 *
 * Prepends the fixed PKCS#8 DER header to reconstruct the full 48-byte DER,
 * then imports it via Node's crypto module.
 */
function privateKeyFromRaw(raw: Buffer): crypto.KeyObject {
  if (raw.length !== 32) {
    throw new Error(`privateKeyFromRaw: expected 32 bytes, got ${raw.length}`);
  }
  const pkcs8Der = Buffer.concat([PKCS8_X25519_HEADER, raw]);
  return crypto.createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
}

/**
 * Reconstruct an X25519 public KeyObject from a 32-byte hex string.
 *
 * Prepends the fixed SPKI DER header to reconstruct the full 44-byte DER.
 */
function publicKeyFromHex(hex: string): crypto.KeyObject {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== 32) {
    throw new Error(`publicKeyFromHex: expected 32 bytes, got ${raw.length}`);
  }
  const spkiDer = Buffer.concat([SPKI_X25519_HEADER, raw]);
  return crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });
}

/**
 * HKDF-SHA-256 key derivation.
 *
 * @param ikm    Input key material.
 * @param salt   Random or structured salt.
 * @param info   Context/application-specific info bytes.
 * @param length Output key length in bytes.
 */
function hkdf(
  ikm: Buffer,
  salt: Buffer,
  info: Buffer,
  length: number,
): Buffer {
  // Extract: PRK = HMAC-SHA256(salt, ikm)
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();

  // Expand: T(n) = HMAC-SHA256(PRK, T(n-1) || info || n)
  // T(0) = empty string, T(1) = HMAC-SHA256(PRK, "" || info || 0x01)
  const blocks: Buffer[] = [];
  let prev = Buffer.alloc(0);
  let totalLength = 0;

  for (let i = 1; totalLength < length; i++) {
    const t = crypto
      .createHmac("sha256", prk)
      .update(prev)
      .update(info)
      .update(Buffer.from([i]))
      .digest();
    blocks.push(t);
    prev = t;
    totalLength += t.length;
  }

  return Buffer.concat(blocks).subarray(0, length);
}

/** Derive a stable machine label from the OS hostname. */
function hostnameLabel(): string {
  return os.hostname().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
}

// ─── Runtime assertion helpers ────────────────────────────────────────────────

function assertString(v: unknown, label: string): asserts v is string {
  if (typeof v !== "string") throw new Error(`${label}: expected string`);
}

function assertHex(v: string, bytes: number, label: string): void {
  if (!/^[0-9a-f]+$/i.test(v) || v.length !== bytes * 2) {
    throw new Error(`${label}: expected ${bytes}-byte hex string`);
  }
}

function assertEncryptedFile(obj: unknown): asserts obj is EncryptedFile {
  if (typeof obj !== "object" || obj === null) {
    throw new Error("EncryptedFile: not an object");
  }
  const o = obj as Record<string, unknown>;

  if (o["version"] !== FORMAT_VERSION) {
    throw new Error(`EncryptedFile: unsupported version ${o["version"]}`);
  }

  if (!Array.isArray(o["recipients"]) || o["recipients"].length === 0) {
    throw new Error("EncryptedFile: missing or empty recipients array");
  }

  for (const r of o["recipients"] as unknown[]) {
    assertRecipient(r);
  }

  assertPayload(o["payload"]);
}

function assertRecipient(obj: unknown): asserts obj is Recipient {
  if (typeof obj !== "object" || obj === null) {
    throw new Error("Recipient: not an object");
  }
  const o = obj as Record<string, unknown>;

  assertString(o["publicKey"], "Recipient.publicKey");
  assertHex(o["publicKey"] as string, 32, "Recipient.publicKey");

  assertString(o["ephemeralKey"], "Recipient.ephemeralKey");
  assertHex(o["ephemeralKey"] as string, 32, "Recipient.ephemeralKey");

  assertString(o["wrappedKey"], "Recipient.wrappedKey");
  assertHex(
    o["wrappedKey"] as string,
    IV_BYTES + KEY_BYTES + TAG_BYTES,
    "Recipient.wrappedKey",
  );
}

function assertPayload(obj: unknown): asserts obj is Payload {
  if (typeof obj !== "object" || obj === null) {
    throw new Error("Payload: not an object");
  }
  const o = obj as Record<string, unknown>;

  assertString(o["iv"], "Payload.iv");
  assertHex(o["iv"] as string, IV_BYTES, "Payload.iv");

  assertString(o["ciphertext"], "Payload.ciphertext");
  if (!/^[0-9a-f]*$/i.test(o["ciphertext"] as string)) {
    throw new Error("Payload.ciphertext: not a hex string");
  }

  assertString(o["tag"], "Payload.tag");
  assertHex(o["tag"] as string, TAG_BYTES, "Payload.tag");
}

function assertPublicKeyRecord(obj: unknown): asserts obj is PublicKeyRecord {
  if (typeof obj !== "object" || obj === null) {
    throw new Error("PublicKeyRecord: not an object");
  }
  const o = obj as Record<string, unknown>;

  if (o["version"] !== FORMAT_VERSION) {
    throw new Error(`PublicKeyRecord: unsupported version ${o["version"]}`);
  }

  assertString(o["publicKey"], "PublicKeyRecord.publicKey");
  assertHex(o["publicKey"] as string, 32, "PublicKeyRecord.publicKey");

  assertString(o["name"], "PublicKeyRecord.name");
  assertString(o["createdAt"], "PublicKeyRecord.createdAt");
}

/** Type-safe Node.js error check. */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
