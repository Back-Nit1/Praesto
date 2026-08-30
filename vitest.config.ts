/**
 * Vitest configuration.
 * ---------------------------------------------------------------------------
 * Two environments coexist on purpose:
 *   - Pure logic (normalizers, mapper, confidence, fingerprints) is tested in
 *     plain `node` - no DOM, no browser, milliseconds per file. This is where
 *     the majority of tests live, which is a deliberate architectural outcome:
 *     if mapping logic needed a browser to test, it would mean DOM concerns had
 *     leaked into it (see spec section 29).
 *   - DOM-dependent code (detector, fill adapters, React UI) opts into `jsdom`
 *     via a `// @vitest-environment jsdom` docblock at the top of the file.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': r('./src'),
      '@shared': r('./src/packages/shared'),
      '@storage': r('./src/packages/storage'),
      '@profile': r('./src/packages/profile'),
      '@form-engine': r('./src/packages/form-engine'),
      '@resume-parser': r('./src/packages/resume-parser'),
      '@fill-engine': r('./src/packages/fill-engine'),
      '@ats': r('./src/packages/ats'),
      '@learning': r('./src/packages/learning'),
      // The network gateway. Isolated in its own package so "what can this
      // extension talk to" is answerable by reading one directory.
      '@backend': r('./src/packages/backend'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      // Coverage is reported for logic packages only. Entrypoint glue and React
      // views are covered by integration tests, not by chasing line percentages.
      include: ['src/packages/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
