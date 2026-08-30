/**
 * At-rest encryption tests.
 *
 * Iteration counts are lowered where a test only needs the round trip - 600k
 * PBKDF2 rounds take ~300ms each and a suite that pays that twenty times is a
 * suite people stop running. The DEFAULT is asserted separately, once, because
 * the default is the thing that actually protects a stolen storage file.
 */
import { describe, expect, it } from 'vitest';
import {
  decryptJson,
  deriveKey,
  encryptJson,
  isEncryptedRecord,
  newSalt,
  sealJson,
  type EncryptedRecord,
} from '@shared/crypto';

/** Cheap iterations, for tests that are about the construction, not the KDF. */
const FAST = 1000;

async function sealFast(value: unknown, passphrase: string): Promise<EncryptedRecord> {
  const salt = newSalt();
  const key = await deriveKey(passphrase, salt, FAST);
  if (!key.ok) throw new Error('key derivation failed');
  const record = await encryptJson(value, key.value, salt, FAST);
  if (!record.ok) throw new Error('encryption failed');
  return record.value;
}

describe('encrypt/decrypt round trip', () => {
  it('returns exactly what went in', async () => {
    const profile = { name: 'A Person', city: 'New Brunswick', skills: ['ts', 'go'] };
    const record = await sealFast(profile, 'correct horse battery staple');

    const opened = await decryptJson<typeof profile>(record, 'correct horse battery staple');

    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value).toEqual(profile);
  });

  it('refuses the wrong passphrase', async () => {
    const record = await sealFast({ secret: 1 }, 'right');
    const opened = await decryptJson(record, 'wrong');

    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe('DECRYPTION_FAILED');
  });

  it('never leaves the plaintext visible in the record', async () => {
    const record = await sealFast({ email: 'applicant@example.com' }, 'pw');
    const serialised = JSON.stringify(record);

    expect(serialised).not.toContain('applicant@example.com');
    expect(serialised).not.toContain('email');
  });
});

describe('authentication', () => {
  it('rejects a tampered ciphertext rather than decrypting it to something plausible', async () => {
    const record = await sealFast({ role: 'applicant' }, 'pw');

    // Flip one base64 character. Without the GCM tag this could decrypt to
    // altered plaintext, and the profile is data the extension ACTS on.
    const flipped = record.data[5] === 'A' ? 'B' : 'A';
    const tampered: EncryptedRecord = {
      ...record,
      data: record.data.slice(0, 5) + flipped + record.data.slice(6),
    };

    const opened = await decryptJson(tampered, 'pw');
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe('DECRYPTION_FAILED');
  });

  it('rejects a swapped IV', async () => {
    const first = await sealFast({ a: 1 }, 'pw');
    const second = await sealFast({ b: 2 }, 'pw');

    const opened = await decryptJson({ ...first, iv: second.iv }, 'pw');
    expect(opened.ok).toBe(false);
  });

  it('refuses a record from a future format version', async () => {
    const record = await sealFast({ a: 1 }, 'pw');
    const future = { ...record, v: 2 } as unknown as EncryptedRecord;

    const opened = await decryptJson(future, 'pw');
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.message).toContain('newer version');
  });
});

describe('nonce and salt discipline', () => {
  it('uses a fresh IV for every encryption', async () => {
    const salt = newSalt();
    const key = await deriveKey('pw', salt, FAST);
    if (!key.ok) throw new Error('key derivation failed');

    const ivs = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const record = await encryptJson({ i }, key.value, salt, FAST);
      if (record.ok) ivs.add(record.value.iv);
    }

    // GCM leaks its authentication key on IV reuse under one key. This is the
    // single most important property in the module.
    expect(ivs.size).toBe(25);
  });

  it('uses a fresh salt per sealed record, so one table cannot open two', async () => {
    const a = await sealFast({ x: 1 }, 'same passphrase');
    const b = await sealFast({ x: 1 }, 'same passphrase');

    expect(a.salt).not.toBe(b.salt);
    // Identical plaintext and passphrase, different ciphertext.
    expect(a.data).not.toBe(b.data);
  });

  it('records the iteration count, so raising it later does not orphan old data', async () => {
    const record = await sealFast({ x: 1 }, 'pw');
    expect(record.iterations).toBe(FAST);

    // Decryption re-derives from the RECORD's count, not today's default.
    const opened = await decryptJson(record, 'pw');
    expect(opened.ok).toBe(true);
  });
});

describe('defaults', () => {
  it('seals at the full iteration count', async () => {
    // The one test that pays the real KDF cost. If this number ever drops, the
    // protection against an offline attack on a stolen storage file drops with
    // it, and that should be a failing test rather than a quiet edit.
    const record = await sealJson({ x: 1 }, 'pw');
    expect(record.ok).toBe(true);
    if (record.ok) expect(record.value.iterations).toBeGreaterThanOrEqual(600_000);
  }, 20_000);
});

describe('isEncryptedRecord', () => {
  it('recognises a real record and rejects anything else', async () => {
    expect(isEncryptedRecord(await sealFast({ a: 1 }, 'pw'))).toBe(true);
    expect(isEncryptedRecord({ v: 1, salt: 'x' })).toBe(false);
    expect(isEncryptedRecord(null)).toBe(false);
    expect(isEncryptedRecord('plaintext')).toBe(false);
  });
});
