/**
 * Global test setup.
 *
 * Kept intentionally thin. Tests that need a DOM opt in per-file with
 * `// @vitest-environment jsdom`; tests that need chrome APIs build an explicit
 * fake and inject it, rather than relying on an ambient global. Implicit global
 * mocks make tests pass for reasons the reader cannot see.
 */
import { setLogLevel } from '../src/packages/shared/logging';

// Silence expected error-path logging so a passing run has a clean transcript.
// A test that specifically asserts on logging can raise this itself.
setLogLevel('silent');
