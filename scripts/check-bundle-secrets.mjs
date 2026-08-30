#!/usr/bin/env node
/**
 * Build-time secret scanner.
 * ---------------------------------------------------------------------------
 * ADDED BY THE SECURITY PASS.
 *
 * THE THING THIS EXISTS TO PREVENT
 * A browser extension has no server side. Everything in `dist/` is shipped to
 * the user's disk and, once published, is downloadable by anyone: the Chrome
 * Web Store serves the CRX, and unzipping it takes one command. Vite/WXT INLINE
 * `import.meta.env.*` values at build time as string literals. So this:
 *
 *     const key = import.meta.env.VITE_ANTHROPIC_API_KEY;   // NEVER DO THIS
 *
 * does not read a secret at runtime - it bakes the secret into a JavaScript
 * file that every user of the extension has a copy of. A `.env` file protects
 * the key from your git history. It does not protect it from your build output.
 *
 * There is no way to hold a shared API key inside an extension. The only
 * architecture that works is a small backend that holds the key and that the
 * extension calls with a per-user credential - see SECURITY.md.
 *
 * WHAT THIS SCRIPT DOES
 * Fails the build if a bundled file contains something shaped like a key. It is
 * a backstop, not a substitute for the architecture, and it is deliberately
 * cheap: one pass per file, one combined regex, size-capped reads. On a typical
 * bundle it runs in a few milliseconds.
 *
 * Usage:  node scripts/check-bundle-secrets.mjs [dir]
 * Exit:   0 clean, 1 findings (build should fail), 2 nothing to scan.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.argv[2] ?? 'dist';

/** Only text-ish build output can leak a literal. Skip images and fonts. */
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.map', '']);

/**
 * Largest file we read into memory.
 *
 * pdf.js alone is a few MB. 32 MB is far above any legitimate bundle chunk and
 * keeps this script's own peak memory bounded on a low-RAM machine.
 */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/**
 * Patterns for credentials that are recognisable by SHAPE.
 *
 * Only vendor-prefixed formats are matched. A generic "40 random characters"
 * rule sounds thorough but matches minified variable soup and hashed asset
 * names constantly, and a scanner that cries wolf is a scanner people delete.
 *
 * Each entry is [name, regex]. The regexes are anchored on their literal
 * prefixes, so the whole set is fast even over a multi-megabyte bundle.
 */
const PATTERNS = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Stripe secret key', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
  // An env var whose NAME says secret, assigned a non-empty literal. Catches a
  // key inlined under a name our vendor patterns do not know.
  [
    'Inlined secret-shaped env value',
    /["'`](?:[A-Z0-9_]*(?:API_KEY|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_TOKEN|CLIENT_SECRET))["'`]\s*:\s*["'`][^"'`\s]{12,}["'`]/,
  ],
];

/**
 * Walk a directory iteratively.
 *
 * An explicit stack rather than recursion: a deep `node_modules`-shaped tree
 * can blow the call stack, and this must not be the thing that breaks a build.
 */
function* walk(dir) {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // Unreadable directory - nothing to scan, not a failure.
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) yield full;
    }
  }
}

function main() {
  let scanned = 0;
  const findings = [];

  try {
    statSync(ROOT);
  } catch {
    console.error(`[secret-scan] nothing at "${ROOT}" - run the build first.`);
    process.exit(2);
  }

  for (const file of walk(ROOT)) {
    if (!SCANNED_EXTENSIONS.has(extname(file).toLowerCase())) continue;

    let size;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      console.warn(`[secret-scan] skipping ${file} (${size} bytes, over the read cap)`);
      continue;
    }

    const text = readFileSync(file, 'utf8');
    scanned++;

    for (const [name, pattern] of PATTERNS) {
      const match = pattern.exec(text);
      if (match === null) continue;
      // Report a fingerprint, never the credential: this output lands in CI
      // logs, which are frequently more public than the bundle.
      findings.push({
        file,
        name,
        preview: `${match[0].slice(0, 6)}...(${match[0].length} chars)`,
      });
    }
  }

  if (findings.length === 0) {
    console.log(`[secret-scan] ${scanned} file(s) scanned, no credentials found.`);
    return;
  }

  console.error(`\n[secret-scan] ${findings.length} possible credential(s) in the build output:\n`);
  for (const finding of findings) {
    console.error(`  ${finding.file}\n    ${finding.name}: ${finding.preview}`);
  }
  console.error(
    '\nA published extension bundle is public. Move the key behind a backend proxy;\n' +
      'see SECURITY.md ("Why an API key cannot live in the extension").\n',
  );
  process.exit(1);
}

main();
