/** Vite config for the development-only resume harness. */
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('.'),
  publicDir: r('../fixtures') === '' ? undefined : r('../'),
  resolve: {
    alias: {
      '@': r('../src'),
      '@shared': r('../src/packages/shared'),
      '@storage': r('../src/packages/storage'),
      '@profile': r('../src/packages/profile'),
      '@form-engine': r('../src/packages/form-engine'),
      '@resume-parser': r('../src/packages/resume-parser'),
      '@fill-engine': r('../src/packages/fill-engine'),
      '@ats': r('../src/packages/ats'),
      '@learning': r('../src/packages/learning'),
    },
  },
  server: { port: 5175 },
});
