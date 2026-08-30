/**
 * Identifier and stable-hash utilities.
 * ---------------------------------------------------------------------------
 * Two very different kinds of identifier live here, and conflating them is a
 * real bug source, so they are named to be impossible to mix up:
 *
 *  1. `newId()` - RANDOM. For records we create (profile entries, audit rows,
 *     learned mappings). Uniqueness matters; reproducibility does not.
 *
 *  2. `stableHash()` - DETERMINISTIC. For semantic fingerprints (spec 11 / 19).
 *     The SAME question on a DIFFERENT page must produce the SAME hash, or the
 *     learning system can never recognise a repeated question. Reproducibility
 *     is the entire point; randomness would silently destroy the feature.
 *
 * WHY NOT SHA-256 VIA WebCrypto
 * crypto.subtle.digest is async and unavailable synchronously. Fingerprints are
 * computed inside a tight DOM scan loop over potentially hundreds of controls;
 * making that loop async would force the whole detector to be async for no
 * security benefit. These hashes are not a security boundary - they are bucket
 * keys for a local lookup table - so a fast non-cryptographic hash is the
 * correct tool. FNV-1a is chosen for good avalanche on short ASCII strings and
 * a trivially auditable implementation.
 */

/**
 * Random, collision-resistant id.
 * crypto.randomUUID exists in every MV3 context (service worker, content
 * script, extension page) on Chrome 92+. The fallback covers non-secure test
 * environments only.
 */
export function newId(prefix?: string): string {
  const raw =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${raw}` : raw;
}

/**
 * FNV-1a, 32-bit, returned as 8 lowercase hex characters.
 *
 * Deterministic across processes and across extension restarts, which is what
 * makes a fingerprint usable as a persistent storage key.
 */
export function stableHash(input: string): string {
  // FNV-1a 32-bit offset basis.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619 (the FNV prime). Math.imul keeps the multiply in 32-bit
    // integer space instead of silently promoting to a lossy float.
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 reinterprets the signed 32-bit result as unsigned before hex.
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Separator used when hashing an ordered list of parts.
 *
 * U+001F (UNIT SEPARATOR) is a C0 control character. It cannot appear in text
 * scraped from a DOM label, an attribute, or a URL, so it is unambiguous.
 *
 * The separator matters: naive concatenation makes ["ab","c"] and ["a","bc"]
 * hash identically, which would merge two genuinely different questions into a
 * single learned mapping and then answer one of them with the other's answer.
 */
const PART_SEPARATOR = '\u001F';

/** Hash an ordered list of parts. `undefined`/`null` parts become empty slots. */
export function stableHashParts(parts: readonly (string | undefined | null)[]): string {
  return stableHash(parts.map((p) => p ?? '').join(PART_SEPARATOR));
}
