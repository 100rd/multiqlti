# Config-Sync Secret Encryption

## Overview

Config-sync stores entity configs (connections, provider-keys, etc.) as YAML files in a
git repository.  Some configs contain sensitive data (API tokens, passwords, webhook secrets).
This document describes how those secrets are protected.

## Design Goals

| Goal | Approach |
|------|----------|
| Secrets never land in git in plaintext | Source file added to `.gitignore`; only the `.secret` file is committed |
| Any enrolled machine can decrypt | Multi-recipient encryption (one key-wrap per machine) |
| Key rotation is safe and auditable | `secrets rotate` regenerates key, re-encrypts all files, publishes new public key |
| No external binary dependency | Pure Node.js `crypto` module only |
| Tamper detection | AES-256-GCM authentication tags on every layer |

## Cryptographic Protocol

### Key Material

Each machine maintains an X25519 key pair:

- **Private key** — stored at `~/.config/mqlti/age-keys.txt` (mode `0600`, directory `0700`)
- **Public key** — exported as JSON to `public-keys/<hostname>.json` in the config repo

The private key is never committed to git; the public key is intentionally public.

### Encryption Algorithm

Inspired by the [age](https://age-encryption.org/v1) specification.

#### Per-recipient key wrapping

For each recipient `R`:

1. Generate an ephemeral X25519 key pair `(e_priv, e_pub)`.
2. Compute ECDH shared secret: `S = ECDH(e_priv, R.pub)`.
3. Derive a 256-bit wrapping key via HKDF-SHA-256:
   - `salt = e_pub || R.pub` (64 bytes concatenated raw key material)
   - `info = "mqlti-age-crypto-v1"` (ASCII bytes)
   - `length = 32`
4. Wrap the symmetric key with AES-256-GCM using the derived wrapping key:
   - Random 96-bit IV per recipient.
   - Produces: `iv(12) | ciphertext(32) | tag(16)` — 60 bytes total, hex-encoded.

#### Payload encryption

1. Generate a random 256-bit symmetric key `K`.
2. Encrypt plaintext with AES-256-GCM:
   - Random 96-bit IV.
   - Produces: `iv`, `ciphertext`, `tag` (all hex-encoded).

#### Decryption

The recipient:

1. Locates their entry in the `recipients` array by matching their public key hex.
2. Recomputes the ECDH shared secret: `S = ECDH(R.priv, e_pub)`.
3. Re-derives the wrapping key (same HKDF parameters).
4. Unwraps `K` using AES-256-GCM — authentication tag is verified here.
5. Decrypts the payload with `K` — authentication tag is verified here.

### Wire Format

`.secret` files are JSON:

```json
{
  "version": 1,
  "recipients": [
    {
      "publicKey":    "<hex 32-byte X25519 public key>",
      "ephemeralKey": "<hex 32-byte ephemeral public key>",
      "wrappedKey":   "<hex 60-byte: iv(12) | ciphertext(32) | tag(16)>",
      "name":         "laptop-alice"
    }
  ],
  "payload": {
    "iv":         "<hex 12-byte nonce>",
    "ciphertext": "<hex>",
    "tag":        "<hex 16-byte auth tag>"
  }
}
```

### Public Key Record Format

`public-keys/<hostname>.json`:

```json
{
  "version":   1,
  "publicKey": "<hex 32-byte X25519 public key>",
  "name":      "laptop-alice",
  "createdAt": "2026-04-17T10:00:00.000Z"
}
```

## CLI Usage

### First-time setup on a new machine

```bash
# Initialise the config repo (only once)
mqlti config init ./my-configs
cd my-configs

# Generate + export your key pair
mqlti config secrets rotate
# → Writes ~/.config/mqlti/age-keys.txt  (private, never committed)
# → Writes public-keys/<hostname>.json    (commit this)

git add public-keys/<hostname>.json
git commit -m "chore: add <hostname> public key"
git push
```

### Encrypt a secret file

```bash
mqlti config secrets add connections/gitlab-main.yaml
# → Creates connections/gitlab-main.yaml.secret  (commit this)
# → Adds connections/gitlab-main.yaml to .gitignore

git add connections/gitlab-main.yaml.secret .gitignore
git commit -m "chore: encrypt gitlab-main connection secrets"
```

### Adding a new machine

```bash
# On the new machine: run rotate to generate + export its key
mqlti config secrets rotate

# Commit the new public key
git add public-keys/<new-hostname>.json
git commit -m "chore: add <new-hostname> public key"

# On any machine that already has a valid key:
git pull
mqlti config secrets rotate   # re-encrypts all .secret files with the updated recipient list
git add -u
git commit -m "chore: rotate secrets — add <new-hostname>"
git push
```

### Key rotation (compromise response)

```bash
# On each trusted machine:
mqlti config secrets rotate
# → generates a new key pair
# → re-encrypts all .secret files
# → overwrites public-keys/<hostname>.json

git add public-keys/ **/*.secret
git commit -m "security: rotate secrets"
git push
```

After rotation, the old private key is gone from `~/.config/mqlti/age-keys.txt`.
Anyone holding only the old key can no longer decrypt secrets after the rotated
`.secret` files are pushed.

### List recipients

```bash
mqlti config secrets list
```

## Threat Model

### In-Scope Threats

| Threat | Mitigation |
|--------|-----------|
| Git repo is compromised (read) | Attacker sees only `.secret` ciphertext — cannot decrypt without a private key |
| `.secret` file is tampered with | AES-256-GCM authentication will fail at decryption |
| Ephemeral key reuse across recipients | Each recipient gets an independent ephemeral key pair |
| HKDF key reuse across contexts | Distinct `info` string (`mqlti-age-crypto-v1`) isolates key derivation |
| Key confusion between public/private roles | ECDH is asymmetric; ephemeral key never leaves the encrypting process |
| Weak RNG | Uses `crypto.randomBytes` (CSPRNG backed by OS entropy) |
| Private key file readable by other users | Written with mode `0600`; parent directory `0700` |

### Out-of-Scope / Assumed

| Assumption |
|------------|
| The machine running the CLI is not compromised (memory dump, process injection) |
| The OS CSPRNG is not compromised |
| The git remote is authenticated (SSH/HTTPS with valid credentials) |
| Public key records in `public-keys/` are reviewed before rotation is run |

### Non-Threats

- **Recipient count is public** — the number and identities (public keys + names) of
  recipients are visible in the `.secret` file. This is intentional: it allows auditing
  and `secrets list` to work without decryption.
- **File size is public** — ciphertext length leaks approximate plaintext length.
  This is accepted for config files.

## Comparison to the age Format

This implementation follows the spirit of the [age v1 spec](https://age-encryption.org/v1)
(X25519 recipient stanzas, HKDF for key derivation, symmetric payload) but uses:

- JSON wire format instead of the age text armor format
- Standard Node.js `crypto` built-ins only (no external `age` binary)
- AES-256-GCM throughout instead of ChaCha20-Poly1305

This means `.secret` files are **not compatible** with the reference `age` binary.
The trade-off is zero external dependencies and direct integration with Node.js crypto APIs.
