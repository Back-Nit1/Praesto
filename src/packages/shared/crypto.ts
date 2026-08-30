/**
 * At-rest encryption.
 * ---------------------------------------------------------------------------
 * THE HONEST VERSION OF WHAT THIS DOES AND DOES NOT BUY.
 *
 * Chrome's profile directory is readable by any process running as the user.
 * So the profile, the learned rules and the resume bytes are readable by
 * anything that user runs - malware, a shared-machine snoop with the screen
 * unlocked, a backup that syncs to somewhere it should not.
 *
 * The tempting fix is "encrypt storage". It is usually theatre: if the
 * extension can decrypt unattended, the key must live beside the data, and an
 * attacker who can read one can read the other. Ceremony, not security.
 *
 * The version that is NOT theatre requires a passphrase the user supplies and
 * we never store. That is what this module implements. The cost is real - a
 * prompt after every browser restart, and no recovery if the passphrase is
 * lost - which is why it is OPT-IN infrastructure rather than something turned
 * on for everyone.
 *
 * WHAT IT IS BUILT FROM, AND WHY
 *
 *   PBKDF2-SHA256, 600,000 iterations
 *     A passphrase is low-entropy; the KDF is the only thing standing between
 *     it and an offline attack on a stolen storage file. 600k is OWASP's 2023
 *     PBKDF2-SHA256 recommendation. Argon2id would be better and WebCrypto
 *     does not have it - shipping a WASM implementation would mean either
 *     `wasm-unsafe-eval` in the CSP or a second megabyte in the bundle, and
 *     600k PBKDF2 is the better trade for this threat model.
 *
 *   AES-256-GCM
 *     Authenticated. The tag means a modified ciphertext FAILS rather than
 *     decrypting to something plausible - which matters here because the
 *     plaintext is a profile the extension acts on. Unauthenticated encryption
 *     would let anyone who can write storage flip bits in an address.
 *
 *   A fresh 96-bit IV per encryption, stored with the record
 *     GCM fails catastrophically on IV reuse - two messages under one key and
 *     IV leak their XOR and the authentication key. 96 bits from a CSPRNG per
 *     message is the standard construction. It is not secret and does not need
 *     to be.
 *
 *   A per-record salt
 *     So the same passphrase produces a different key per record, and a
 *     precomputed table is useless.
 *
 * PERFORMANCE
 * Key derivation is deliberately slow - that is its function - so it is done
 * ONCE per session and the resulting CryptoKey is reused. `deriveKey` is the
 * expensive call (~300ms on a low-end machine at 600k iterations); `encrypt`
 * and `decrypt` are microseconds. Never call `deriveKey` in a loop.
 */
import { AppError } from '@shared/errors';
import { err, ok, type Result } from '@shared/result';

/** OWASP's 2023 floor for PBKDF2-SHA256. Raise it, never lower it. */
const PBKDF2_ITERATIONS = 600_000;

const SALT_BYTES = 16;
const IV_BYTES = 12; // 96 bits - the size AES-GCM is specified around.
const KEY_BITS = 256;

/**
 * An encrypted record.
 *
 * Everything except the passphrase travels with the ciphertext, base64'd so it
 * survives `chrome.storage`'s JSON serialisation. Salt and IV are not secret:
 * publishing them is part of the construction, and hiding them would buy
 * nothing while making the format undecryptable by design.
 */
export interface EncryptedRecord {
  /** Format version, so a future KDF change can be migrated rather than guessed. */
  v: 1;
  /** Base64 salt for PBKDF2. */
  salt: string;
  /** Base64 IV for AES-GCM. Fresh per encryption, never reused. */
  iv: string;
  /** Base64 ciphertext, with the GCM tag appended by WebCrypto. */
  data: string;
  /** Iteration count in force when this record was written. */
  iterations: number;
}

/** Is WebCrypto available here? False in a non-secure context. */
function subtle(): SubtleCrypto | undefined {
  const api = globalThis.crypto as Crypto | undefined;
  return api?.subtle;
}

/** Random bytes from the platform CSPRNG. Never Math.random. */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Base64 helpers.
 *
 * Chunked, because `String.fromCharCode(...bytes)` on a large array exceeds
 * the argument limit and throws a RangeError - a failure that only appears on
 * bigger inputs and reads as a mystery.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Derive an AES-GCM key from a passphrase and salt.
 *
 * EXPENSIVE ON PURPOSE. Call once per session, hold the returned key, and let
 * it fall out of scope when the session ends. A `CryptoKey` derived as
 * non-extractable cannot be read back out of the object even by our own code,
 * so a bug that logs it logs an opaque handle rather than key material.
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<Result<CryptoKey, AppError>> {
  const api = subtle();
  if (api === undefined) {
    return err(new AppError('CRYPTO_UNAVAILABLE', 'Encryption is not available in this context'));
  }

  try {
    const material = await api.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );

    const key = await api.deriveKey(
      { name: 'PBKDF2', salt: salt as unknown as BufferSource, hash: 'SHA-256', iterations },
      material,
      { name: 'AES-GCM', length: KEY_BITS },
      // NON-EXTRACTABLE. There is no reason for our code to see the bytes, and
      // making that impossible removes a whole class of accidental leak.
      false,
      ['encrypt', 'decrypt'],
    );

    return ok(key);
  } catch (error) {
    return err(new AppError('CRYPTO_UNAVAILABLE', 'Could not derive a key', { cause: error }));
  }
}

/** A fresh salt for a new record. */
export function newSalt(): Uint8Array {
  return randomBytes(SALT_BYTES);
}

/**
 * Encrypt a JSON-serialisable value.
 *
 * Takes the KEY, not the passphrase, so a caller cannot accidentally re-derive
 * (and pay 300ms) per item. The salt travels in the record so `decrypt` can
 * re-derive from the passphrase on a later session.
 */
export async function encryptJson(
  value: unknown,
  key: CryptoKey,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<Result<EncryptedRecord, AppError>> {
  const api = subtle();
  if (api === undefined) {
    return err(new AppError('CRYPTO_UNAVAILABLE', 'Encryption is not available in this context'));
  }

  try {
    // A FRESH IV every time. Reuse under one key is the failure mode that
    // breaks GCM outright - see the module header.
    const iv = randomBytes(IV_BYTES);
    const plaintext = new TextEncoder().encode(JSON.stringify(value));

    const ciphertext = await api.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      plaintext as unknown as BufferSource,
    );

    return ok({
      v: 1,
      salt: toBase64(salt),
      iv: toBase64(iv),
      data: toBase64(new Uint8Array(ciphertext)),
      iterations,
    });
  } catch (error) {
    return err(new AppError('UNKNOWN', 'Could not encrypt', { cause: error }));
  }
}

/**
 * Decrypt a record with a passphrase.
 *
 * Re-derives the key from the record's own salt and iteration count, which is
 * what lets an old record still open after the iteration count is raised.
 *
 * A WRONG PASSPHRASE AND A TAMPERED RECORD PRODUCE THE SAME ERROR, and that is
 * deliberate: GCM's tag check fails identically for both, and inventing a
 * distinction would mean guessing. The message says what the user can act on.
 */
export async function decryptJson<T>(
  record: EncryptedRecord,
  passphrase: string,
): Promise<Result<T, AppError>> {
  const api = subtle();
  if (api === undefined) {
    return err(new AppError('CRYPTO_UNAVAILABLE', 'Encryption is not available in this context'));
  }

  if (record.v !== 1) {
    return err(new AppError('DECRYPTION_FAILED', 'This data was written by a newer version'));
  }

  const derived = await deriveKey(passphrase, fromBase64(record.salt), record.iterations);
  if (!derived.ok) return err(derived.error);

  try {
    const plaintext = await api.decrypt(
      { name: 'AES-GCM', iv: fromBase64(record.iv) as unknown as BufferSource },
      derived.value,
      fromBase64(record.data) as unknown as BufferSource,
    );

    return ok(JSON.parse(new TextDecoder().decode(plaintext)) as T);
  } catch {
    // No `cause`: the exception text from WebCrypto says nothing useful and
    // logging it around a failed decryption is how key material ends up in a
    // console by accident.
    return err(
      new AppError('DECRYPTION_FAILED', 'Wrong passphrase, or this data has been altered'),
    );
  }
}

/**
 * Encrypt with a passphrase, deriving a key and salt in one call.
 *
 * The convenience path, for a single record. Pays the full KDF cost, so it is
 * wrong for a loop - derive once with `deriveKey` and call `encryptJson`.
 */
export async function sealJson(
  value: unknown,
  passphrase: string,
): Promise<Result<EncryptedRecord, AppError>> {
  const salt = newSalt();
  const key = await deriveKey(passphrase, salt);
  if (!key.ok) return err(key.error);
  return encryptJson(value, key.value, salt);
}

/** True when a value looks like one of our encrypted records. */
export function isEncryptedRecord(value: unknown): value is EncryptedRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['v'] === 1 &&
    typeof record['salt'] === 'string' &&
    typeof record['iv'] === 'string' &&
    typeof record['data'] === 'string' &&
    typeof record['iterations'] === 'number'
  );
}
