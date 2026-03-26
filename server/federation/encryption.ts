import crypto from "crypto";

/**
 * Encrypted payload structure embedded in FederationMessage.payload
 * when E2E encryption is active for a peer.
 */
export interface EncryptedPayload {
  encrypted: true;
  ciphertext: string; // base64
  iv: string; // base64, 12 bytes for GCM
  authTag: string; // base64, 16 bytes
}

/** ECDH key pair for federation key exchange. */
interface KeyPairData {
  publicKey: Buffer;
  privateKey: Buffer;
  ecdh: crypto.ECDH;
}

/** Stored peer key with generation tracking for rotation. */
interface PeerKeyEntry {
  key: Buffer;
  generation: number;
}

const ECDH_CURVE = "prime256v1";
const HKDF_HASH = "sha256";
const HKDF_INFO = "federation-e2e";
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

/**
 * Federation E2E encryption using ECDH key exchange + AES-256-GCM.
 *
 * Each instance generates an ECDH keypair on startup. During the
 * hello/hello-ack handshake, public keys are exchanged. A shared
 * secret is derived via ECDH, then an AES-256 key is produced via
 * HKDF using the cluster secret as salt.
 */
export class FederationEncryption {
  private peerKeys = new Map<string, PeerKeyEntry>();
  private previousPeerKeys = new Map<string, PeerKeyEntry>();
  private keyPair: KeyPairData;
  private generation = 0;

  constructor(private clusterSecret: string) {
    this.keyPair = this.createKeyPair();
  }

  /** Get the public key for exchange during handshake. */
  getPublicKey(): string {
    return this.keyPair.publicKey.toString("base64");
  }

  /** Current key generation number (increments on rotation). */
  getGeneration(): number {
    return this.generation;
  }

  /**
   * Derive a shared AES-256 key from a peer's ECDH public key.
   * Must be called after receiving the peer's public key in handshake.
   */
  deriveSharedKey(peerInstanceId: string, peerPublicKey: string): void {
    let sharedSecret: Buffer;
    try {
      const peerPubBuf = Buffer.from(peerPublicKey, "base64");
      sharedSecret = this.keyPair.ecdh.computeSecret(peerPubBuf);
    } catch (err) {
      throw new Error(`Invalid ECDH public key from peer ${peerInstanceId}: ${(err as Error).message}`);
    }
    const derived = this.deriveAesKey(sharedSecret);
    this.peerKeys.set(peerInstanceId, {
      key: derived,
      generation: this.generation,
    });
  }

  /** Encrypt a payload for a specific peer using AES-256-GCM. */
  encrypt(peerInstanceId: string, payload: unknown): EncryptedPayload {
    const entry = this.peerKeys.get(peerInstanceId);
    if (!entry) {
      throw new Error(`No encryption key for peer: ${peerInstanceId}`);
    }
    return this.encryptWithKey(entry.key, payload);
  }

  /** Decrypt a payload from a specific peer. Tries current key, then previous. */
  decrypt(peerInstanceId: string, encrypted: EncryptedPayload): unknown {
    const entry = this.peerKeys.get(peerInstanceId);
    if (entry) {
      try {
        return this.decryptWithKey(entry.key, encrypted);
      } catch {
        // Fall through to try previous key
      }
    }
    const prev = this.previousPeerKeys.get(peerInstanceId);
    if (prev) {
      return this.decryptWithKey(prev.key, encrypted);
    }
    throw new Error(`No encryption key for peer: ${peerInstanceId}`);
  }

  /** Check whether we have a derived key for a peer. */
  hasPeerKey(peerInstanceId: string): boolean {
    return this.peerKeys.has(peerInstanceId);
  }

  /**
   * Rotate keys: generate new ECDH keypair, increment generation.
   * Previous peer keys are preserved briefly for in-flight messages.
   */
  rotateKeys(): string {
    this.previousPeerKeys = new Map(this.peerKeys);
    this.peerKeys.clear();
    this.keyPair = this.createKeyPair();
    this.generation += 1;
    return this.getPublicKey();
  }

  /** Remove key material for a disconnected peer. */
  removePeer(peerInstanceId: string): void {
    this.peerKeys.delete(peerInstanceId);
    this.previousPeerKeys.delete(peerInstanceId);
  }

  // -- Private helpers --------------------------------------------------------

  private createKeyPair(): KeyPairData {
    const ecdh = crypto.createECDH(ECDH_CURVE);
    ecdh.generateKeys();
    return {
      publicKey: ecdh.getPublicKey(),
      privateKey: ecdh.getPrivateKey(),
      ecdh,
    };
  }

  private deriveAesKey(sharedSecret: Buffer): Buffer {
    return Buffer.from(
      crypto.hkdfSync(
        HKDF_HASH,
        sharedSecret,
        this.clusterSecret,
        HKDF_INFO,
        AES_KEY_BYTES,
      ),
    );
  }

  private encryptWithKey(key: Buffer, payload: unknown): EncryptedPayload {
    const iv = crypto.randomBytes(GCM_IV_BYTES);
    const plaintext = JSON.stringify(payload);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
      authTagLength: GCM_AUTH_TAG_BYTES,
    });
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      encrypted: true,
      ciphertext: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
    };
  }

  private decryptWithKey(key: Buffer, enc: EncryptedPayload): unknown {
    const iv = Buffer.from(enc.iv, "base64");
    const ciphertext = Buffer.from(enc.ciphertext, "base64");
    const authTag = Buffer.from(enc.authTag, "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: GCM_AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString("utf8")) as unknown;
  }
}

/** Type guard: check if a payload is an EncryptedPayload. */
export function isEncryptedPayload(
  payload: unknown,
): payload is EncryptedPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    p.encrypted === true &&
    typeof p.ciphertext === "string" &&
    typeof p.iv === "string" &&
    typeof p.authTag === "string"
  );
}
