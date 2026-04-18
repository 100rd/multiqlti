/**
 * Tests for server/config-sync/age-crypto.ts (issue #315)
 *
 * Coverage:
 *   - Key generation: produces valid 32-byte hex public key
 *   - Key serialization/deserialization roundtrip
 *   - loadOrCreateKeyPair: creates file when missing, reads file when present
 *   - encrypt/decrypt roundtrip: single recipient
 *   - encrypt/decrypt roundtrip: multiple recipients (multi-recipient)
 *   - decrypt: correct recipient in a multi-recipient file
 *   - decrypt: key is not a recipient → throws
 *   - decrypt: corrupted ciphertext → throws (authentication failure)
 *   - decrypt: corrupted wrapped key → throws
 *   - decrypt: wrong format version → throws
 *   - decrypt: empty recipients array → throws before even trying
 *   - serializeEncryptedFile / parseEncryptedFile roundtrip
 *   - parseEncryptedFile: invalid JSON → throws
 *   - parseEncryptedFile: missing fields → throws
 *   - parseEncryptedFile: wrong version → throws
 *   - buildPublicKeyRecord / parsePublicKeyRecord roundtrip
 *   - parsePublicKeyRecord: missing fields → throws
 *   - encryptFile / decryptFile: file I/O roundtrip
 *   - reEncryptAll: re-encrypts files for a new recipient set
 *   - loadPublicKeys: reads .json files, skips non-.json, skips malformed
 *   - encrypt: empty recipients → throws
 *   - Large plaintext (>16 KB) roundtrip
 *   - Empty plaintext roundtrip
 *   - deserializeKeyPair: missing private key line → throws
 *   - deserializeKeyPair: wrong key length → throws
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";

import {
  generateKeyPair,
  serializeKeyPair,
  deserializeKeyPair,
  loadOrCreateKeyPair,
  buildPublicKeyRecord,
  parsePublicKeyRecord,
  loadPublicKeys,
  encrypt,
  decrypt,
  serializeEncryptedFile,
  parseEncryptedFile,
  encryptFile,
  decryptFile,
  reEncryptAll,
  type AgeKeyPair,
  type EncryptedFile,
} from "../../../server/config-sync/age-crypto.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Create a temporary directory; returns its realpath (resolves /var → /private/var on macOS). */
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "age-crypto-test-"));
  return fs.realpath(dir);
}

// ─── Key generation ───────────────────────────────────────────────────────────

describe("generateKeyPair", () => {
  it("produces a valid X25519 key pair", () => {
    const kp = generateKeyPair("test-machine");
    expect(kp.publicKey.type).toBe("public");
    expect(kp.privateKey.type).toBe("private");
    expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.name).toBe("test-machine");
  });

  it("produces a different key pair each call", () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    expect(kp1.publicKeyHex).not.toBe(kp2.publicKeyHex);
  });

  it("works without a name argument", () => {
    const kp = generateKeyPair();
    expect(kp.name).toBeUndefined();
    expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── Key serialization ────────────────────────────────────────────────────────

describe("serializeKeyPair / deserializeKeyPair", () => {
  it("roundtrip preserves public key hex", () => {
    const original = generateKeyPair("laptop-alice");
    const serialized = serializeKeyPair(original);
    const restored = deserializeKeyPair(serialized);
    expect(restored.publicKeyHex).toBe(original.publicKeyHex);
    expect(restored.name).toBe("laptop-alice");
  });

  it("roundtrip without name", () => {
    const original = generateKeyPair();
    const serialized = serializeKeyPair(original);
    const restored = deserializeKeyPair(serialized);
    expect(restored.publicKeyHex).toBe(original.publicKeyHex);
    expect(restored.name).toBeUndefined();
  });

  it("restored private key can decrypt data encrypted with original public key", () => {
    const kp = generateKeyPair("test");
    const serialized = serializeKeyPair(kp);
    const restored = deserializeKeyPair(serialized);

    const plaintext = Buffer.from("secret message");
    const ef = encrypt(plaintext, [{ publicKey: kp.publicKeyHex }]);
    const decrypted = decrypt(ef, restored.privateKey);
    expect(decrypted.toString()).toBe("secret message");
  });

  it("throws when private line is missing", () => {
    expect(() => deserializeKeyPair("# public-key: abc\n")).toThrow(
      "missing 'private:' line",
    );
  });

  it("throws when private key hex is wrong length", () => {
    expect(() => deserializeKeyPair("private: abcd\n")).toThrow(
      "expected 32-byte private key",
    );
  });
});

// ─── loadOrCreateKeyPair ──────────────────────────────────────────────────────

describe("loadOrCreateKeyPair", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the key file when it does not exist", async () => {
    const keyFile = path.join(tmpDir, "keys", "age-keys.txt");
    const kp = await loadOrCreateKeyPair(keyFile, "new-machine");
    expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);

    // File was written
    const content = await fs.readFile(keyFile, "utf-8");
    expect(content).toContain("private:");
    expect(content).toContain("new-machine");

    // File has restrictive permissions (0600)
    const stat = await fs.stat(keyFile);
    // On POSIX: lower 9 bits — owner rw, no group/other
    expect(stat.mode & 0o077).toBe(0);
  });

  it("reads an existing key file without regenerating", async () => {
    const keyFile = path.join(tmpDir, "age-keys.txt");
    const kp1 = await loadOrCreateKeyPair(keyFile, "m1");
    const kp2 = await loadOrCreateKeyPair(keyFile, "m1");
    // Same key loaded twice
    expect(kp2.publicKeyHex).toBe(kp1.publicKeyHex);
  });

  it("the loaded key can encrypt/decrypt", async () => {
    const keyFile = path.join(tmpDir, "age-keys.txt");
    const kp = await loadOrCreateKeyPair(keyFile);
    const plaintext = Buffer.from("hello loadOrCreate");
    const ef = encrypt(plaintext, [{ publicKey: kp.publicKeyHex }]);
    const decrypted = decrypt(ef, kp.privateKey);
    expect(decrypted.toString()).toBe("hello loadOrCreate");
  });
});

// ─── Encrypt / Decrypt ────────────────────────────────────────────────────────

describe("encrypt / decrypt", () => {
  it("single-recipient roundtrip", () => {
    const kp = generateKeyPair("test");
    const plaintext = Buffer.from("hello world");
    const ef = encrypt(plaintext, [{ publicKey: kp.publicKeyHex }]);
    const result = decrypt(ef, kp.privateKey);
    expect(result.toString()).toBe("hello world");
  });

  it("multi-recipient: each key can decrypt independently", () => {
    const kp1 = generateKeyPair("alice");
    const kp2 = generateKeyPair("bob");
    const kp3 = generateKeyPair("carol");

    const plaintext = Buffer.from("shared secret");
    const ef = encrypt(plaintext, [
      { publicKey: kp1.publicKeyHex, name: "alice" },
      { publicKey: kp2.publicKeyHex, name: "bob" },
      { publicKey: kp3.publicKeyHex, name: "carol" },
    ]);

    expect(decrypt(ef, kp1.privateKey).toString()).toBe("shared secret");
    expect(decrypt(ef, kp2.privateKey).toString()).toBe("shared secret");
    expect(decrypt(ef, kp3.privateKey).toString()).toBe("shared secret");
  });

  it("EncryptedFile has three recipients", () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    const kp3 = generateKeyPair();
    const ef = encrypt(Buffer.from("x"), [
      { publicKey: kp1.publicKeyHex },
      { publicKey: kp2.publicKeyHex },
      { publicKey: kp3.publicKeyHex },
    ]);
    expect(ef.recipients).toHaveLength(3);
  });

  it("recipient names are preserved in the encrypted file", () => {
    const kp = generateKeyPair("my-laptop");
    const ef = encrypt(Buffer.from("test"), [
      { publicKey: kp.publicKeyHex, name: "my-laptop" },
    ]);
    expect(ef.recipients[0]!.name).toBe("my-laptop");
  });

  it("throws when recipient list is empty", () => {
    expect(() => encrypt(Buffer.from("test"), [])).toThrow(
      "at least one recipient required",
    );
  });

  it("throws when the decryption key is not a recipient", () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair(); // Not a recipient
    const ef = encrypt(Buffer.from("test"), [{ publicKey: kp1.publicKeyHex }]);
    expect(() => decrypt(ef, kp2.privateKey)).toThrow(
      "not a recipient",
    );
  });

  it("throws on corrupted payload ciphertext", () => {
    const kp = generateKeyPair();
    const ef = encrypt(Buffer.from("test data"), [
      { publicKey: kp.publicKeyHex },
    ]);
    // Flip a byte in the payload ciphertext
    const corrupted: EncryptedFile = {
      ...ef,
      payload: {
        ...ef.payload,
        ciphertext: "deadbeef" + ef.payload.ciphertext.slice(8),
      },
    };
    expect(() => decrypt(corrupted, kp.privateKey)).toThrow(
      "payload authentication failed",
    );
  });

  it("throws on corrupted payload auth tag", () => {
    const kp = generateKeyPair();
    const ef = encrypt(Buffer.from("test data"), [
      { publicKey: kp.publicKeyHex },
    ]);
    const corrupted: EncryptedFile = {
      ...ef,
      payload: {
        ...ef.payload,
        tag: "00000000000000000000000000000000",
      },
    };
    expect(() => decrypt(corrupted, kp.privateKey)).toThrow(
      "payload authentication failed",
    );
  });

  it("throws on corrupted wrapped key", () => {
    const kp = generateKeyPair();
    const ef = encrypt(Buffer.from("test"), [{ publicKey: kp.publicKeyHex }]);
    // Flip the wrapped key bytes
    const origWrapped = ef.recipients[0]!.wrappedKey;
    const flipped =
      origWrapped.slice(0, 2) +
      (parseInt(origWrapped[2]!, 16) ^ 0xf).toString(16) +
      origWrapped.slice(3);
    const corrupted: EncryptedFile = {
      ...ef,
      recipients: [{ ...ef.recipients[0]!, wrappedKey: flipped }],
    };
    expect(() => decrypt(corrupted, kp.privateKey)).toThrow();
  });

  it("throws on unsupported version", () => {
    const kp = generateKeyPair();
    const ef = encrypt(Buffer.from("test"), [{ publicKey: kp.publicKeyHex }]);
    const badVersion = { ...ef, version: 99 } as unknown as EncryptedFile;
    expect(() => decrypt(badVersion, kp.privateKey)).toThrow(
      "Unsupported encrypted file version",
    );
  });

  it("empty plaintext roundtrip", () => {
    const kp = generateKeyPair();
    const ef = encrypt(Buffer.alloc(0), [{ publicKey: kp.publicKeyHex }]);
    const result = decrypt(ef, kp.privateKey);
    expect(result.length).toBe(0);
  });

  it("large plaintext (64 KB) roundtrip", () => {
    const kp = generateKeyPair();
    const plaintext = crypto.randomBytes(64 * 1024);
    const ef = encrypt(plaintext, [{ publicKey: kp.publicKeyHex }]);
    const result = decrypt(ef, kp.privateKey);
    expect(result.equals(plaintext)).toBe(true);
  });

  it("binary data roundtrip", () => {
    const kp = generateKeyPair();
    const plaintext = Buffer.from([0, 1, 2, 3, 255, 254, 253, 128]);
    const ef = encrypt(plaintext, [{ publicKey: kp.publicKeyHex }]);
    const result = decrypt(ef, kp.privateKey);
    expect(result.equals(plaintext)).toBe(true);
  });

  it("each encryption produces different ciphertext (IV freshness)", () => {
    const kp = generateKeyPair();
    const plaintext = Buffer.from("same data");
    const ef1 = encrypt(plaintext, [{ publicKey: kp.publicKeyHex }]);
    const ef2 = encrypt(plaintext, [{ publicKey: kp.publicKeyHex }]);
    expect(ef1.payload.ciphertext).not.toBe(ef2.payload.ciphertext);
    expect(ef1.payload.iv).not.toBe(ef2.payload.iv);
  });
});

// ─── Serialization ────────────────────────────────────────────────────────────

describe("serializeEncryptedFile / parseEncryptedFile", () => {
  it("roundtrip preserves all fields", () => {
    const kp = generateKeyPair("test");
    const ef = encrypt(Buffer.from("roundtrip test"), [
      { publicKey: kp.publicKeyHex, name: "test" },
    ]);
    const json = serializeEncryptedFile(ef);
    const parsed = parseEncryptedFile(json);
    expect(parsed.version).toBe(ef.version);
    expect(parsed.recipients).toHaveLength(1);
    expect(parsed.recipients[0]!.publicKey).toBe(ef.recipients[0]!.publicKey);
    expect(parsed.payload.ciphertext).toBe(ef.payload.ciphertext);
  });

  it("parsed file can be decrypted", () => {
    const kp = generateKeyPair();
    const ef = encrypt(Buffer.from("parse test"), [
      { publicKey: kp.publicKeyHex },
    ]);
    const json = serializeEncryptedFile(ef);
    const parsed = parseEncryptedFile(json);
    const result = decrypt(parsed, kp.privateKey);
    expect(result.toString()).toBe("parse test");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseEncryptedFile("not json")).toThrow("not valid JSON");
  });

  it("throws when version is missing", () => {
    const obj = { recipients: [], payload: {} };
    expect(() => parseEncryptedFile(JSON.stringify(obj))).toThrow();
  });

  it("throws when version is wrong", () => {
    const obj = { version: 2, recipients: [], payload: {} };
    expect(() => parseEncryptedFile(JSON.stringify(obj))).toThrow(
      "unsupported version",
    );
  });

  it("throws when recipients array is empty", () => {
    const obj = {
      version: 1,
      recipients: [],
      payload: { iv: "a".repeat(24), ciphertext: "", tag: "a".repeat(32) },
    };
    expect(() => parseEncryptedFile(JSON.stringify(obj))).toThrow(
      "empty recipients",
    );
  });

  it("throws when payload iv has wrong length", () => {
    const kp = generateKeyPair();
    const ef = encrypt(Buffer.from("x"), [{ publicKey: kp.publicKeyHex }]);
    const bad = { ...ef, payload: { ...ef.payload, iv: "aabb" } };
    expect(() => parseEncryptedFile(JSON.stringify(bad))).toThrow(
      "Payload.iv",
    );
  });

  it("throws when recipient publicKey has wrong hex length", () => {
    const kp = generateKeyPair();
    const ef = encrypt(Buffer.from("x"), [{ publicKey: kp.publicKeyHex }]);
    const bad = {
      ...ef,
      recipients: [{ ...ef.recipients[0]!, publicKey: "aabb" }],
    };
    expect(() => parseEncryptedFile(JSON.stringify(bad))).toThrow(
      "Recipient.publicKey",
    );
  });
});

// ─── PublicKeyRecord ──────────────────────────────────────────────────────────

describe("buildPublicKeyRecord / parsePublicKeyRecord", () => {
  it("roundtrip preserves all fields", () => {
    const kp = generateKeyPair("server-1");
    const record = buildPublicKeyRecord(kp);
    expect(record.publicKey).toBe(kp.publicKeyHex);
    expect(record.name).toBe("server-1");
    expect(record.version).toBe(1);
    expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const json = JSON.stringify(record);
    const parsed = parsePublicKeyRecord(json);
    expect(parsed.publicKey).toBe(kp.publicKeyHex);
    expect(parsed.name).toBe("server-1");
  });

  it("throws on invalid JSON", () => {
    expect(() => parsePublicKeyRecord("bad")).toThrow("not valid JSON");
  });

  it("throws on wrong version", () => {
    const kp = generateKeyPair("x");
    const record = { ...buildPublicKeyRecord(kp), version: 2 };
    expect(() => parsePublicKeyRecord(JSON.stringify(record))).toThrow(
      "unsupported version",
    );
  });

  it("throws when publicKey field is missing", () => {
    const obj = { version: 1, name: "x", createdAt: new Date().toISOString() };
    expect(() => parsePublicKeyRecord(JSON.stringify(obj))).toThrow(
      "PublicKeyRecord.publicKey",
    );
  });

  it("throws when publicKey hex length is wrong", () => {
    const obj = {
      version: 1,
      publicKey: "aabb",
      name: "x",
      createdAt: new Date().toISOString(),
    };
    expect(() => parsePublicKeyRecord(JSON.stringify(obj))).toThrow(
      "PublicKeyRecord.publicKey",
    );
  });
});

// ─── File I/O ─────────────────────────────────────────────────────────────────

describe("encryptFile / decryptFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("encrypts a file and decrypts it back", async () => {
    const kp = generateKeyPair("file-test");
    const srcPath = path.join(tmpDir, "connection.yaml");
    const plaintext = "api_key: supersecret123\nendpoint: https://api.example.com\n";
    await fs.writeFile(srcPath, plaintext, "utf-8");

    const secretPath = await encryptFile(
      srcPath,
      [{ publicKey: kp.publicKeyHex, name: "file-test" }],
    );

    expect(secretPath).toBe(srcPath + ".secret");
    const secretExists = await fs.access(secretPath).then(() => true, () => false);
    expect(secretExists).toBe(true);

    const decrypted = await decryptFile(secretPath, kp.privateKey);
    expect(decrypted.toString("utf-8")).toBe(plaintext);
  });

  it("uses custom output path when provided", async () => {
    const kp = generateKeyPair();
    const srcPath = path.join(tmpDir, "src.yaml");
    await fs.writeFile(srcPath, "data: value", "utf-8");

    const customPath = path.join(tmpDir, "custom.enc");
    const secretPath = await encryptFile(
      srcPath,
      [{ publicKey: kp.publicKeyHex }],
      customPath,
    );

    expect(secretPath).toBe(customPath);
    const decrypted = await decryptFile(customPath, kp.privateKey);
    expect(decrypted.toString()).toBe("data: value");
  });

  it("decryptFile throws when key is not a recipient", async () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    const srcPath = path.join(tmpDir, "src.yaml");
    await fs.writeFile(srcPath, "secret: data", "utf-8");

    const secretPath = await encryptFile(srcPath, [
      { publicKey: kp1.publicKeyHex },
    ]);

    await expect(decryptFile(secretPath, kp2.privateKey)).rejects.toThrow(
      "not a recipient",
    );
  });
});

// ─── reEncryptAll ─────────────────────────────────────────────────────────────

describe("reEncryptAll", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("re-encrypts files for a new recipient set", async () => {
    const oldKp = generateKeyPair("old-machine");
    const newKp = generateKeyPair("new-machine");

    // Create two source files + encrypt them for oldKp only
    const paths: string[] = [];
    for (let i = 0; i < 2; i++) {
      const src = path.join(tmpDir, `file${i}.yaml`);
      await fs.writeFile(src, `secret: value${i}`);
      const secret = src + ".secret";
      await fs.writeFile(
        secret,
        serializeEncryptedFile(
          encrypt(Buffer.from(`secret: value${i}`), [
            { publicKey: oldKp.publicKeyHex },
          ]),
        ),
      );
      paths.push(secret);
    }

    // Re-encrypt for both old and new
    const reEncrypted = await reEncryptAll(paths, oldKp.privateKey, [
      { publicKey: oldKp.publicKeyHex, name: "old-machine" },
      { publicKey: newKp.publicKeyHex, name: "new-machine" },
    ]);

    expect(reEncrypted).toHaveLength(2);

    // Both keys can now decrypt
    for (let i = 0; i < 2; i++) {
      const dec1 = await decryptFile(paths[i]!, oldKp.privateKey);
      const dec2 = await decryptFile(paths[i]!, newKp.privateKey);
      expect(dec1.toString()).toBe(`secret: value${i}`);
      expect(dec2.toString()).toBe(`secret: value${i}`);
    }
  });

  it("returns empty array when no files provided", async () => {
    const kp = generateKeyPair();
    const result = await reEncryptAll([], kp.privateKey, [
      { publicKey: kp.publicKeyHex },
    ]);
    expect(result).toHaveLength(0);
  });
});

// ─── loadPublicKeys ───────────────────────────────────────────────────────────

describe("loadPublicKeys", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads all valid .json files in the directory", async () => {
    const kp1 = generateKeyPair("m1");
    const kp2 = generateKeyPair("m2");
    await fs.writeFile(
      path.join(tmpDir, "m1.json"),
      JSON.stringify(buildPublicKeyRecord(kp1)),
    );
    await fs.writeFile(
      path.join(tmpDir, "m2.json"),
      JSON.stringify(buildPublicKeyRecord(kp2)),
    );

    const records = await loadPublicKeys(tmpDir);
    expect(records).toHaveLength(2);
    const keys = records.map((r) => r.publicKey).sort();
    expect(keys).toContain(kp1.publicKeyHex);
    expect(keys).toContain(kp2.publicKeyHex);
  });

  it("skips .gitkeep and non-.json files", async () => {
    const kp = generateKeyPair("m1");
    await fs.writeFile(path.join(tmpDir, ".gitkeep"), "");
    await fs.writeFile(path.join(tmpDir, "README.txt"), "info");
    await fs.writeFile(
      path.join(tmpDir, "m1.json"),
      JSON.stringify(buildPublicKeyRecord(kp)),
    );

    const records = await loadPublicKeys(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0]!.publicKey).toBe(kp.publicKeyHex);
  });

  it("skips malformed .json files without throwing", async () => {
    const kp = generateKeyPair("good");
    await fs.writeFile(path.join(tmpDir, "bad.json"), "not-json");
    await fs.writeFile(
      path.join(tmpDir, "good.json"),
      JSON.stringify(buildPublicKeyRecord(kp)),
    );

    const records = await loadPublicKeys(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe("good");
  });

  it("returns empty array when directory does not exist", async () => {
    const records = await loadPublicKeys(path.join(tmpDir, "no-such-dir"));
    expect(records).toHaveLength(0);
  });

  it("returns empty array for empty directory", async () => {
    const records = await loadPublicKeys(tmpDir);
    expect(records).toHaveLength(0);
  });
});
