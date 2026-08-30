/**
 * Browser harness for the resume pipeline.
 *
 * Exists because the Node tests cannot see the failure class that actually bit
 * us: PDF.js resolving its worker. Node and Chrome load modules differently and
 * bundle differently, so "it parses in vitest" is not evidence that it parses in
 * the extension. This runs the real code in the real runtime.
 *
 * Development only - not part of the extension build.
 */
import { parseResume } from '../src/packages/resume-parser/index';

const out = document.getElementById('out') as HTMLPreElement;
const log = (text: string, cls = '') => {
  out.innerHTML += `\n<span class="${cls}">${text}</span>`;
};

async function run(bytes: ArrayBuffer, name: string): Promise<void> {
  out.textContent = `parsing ${name} (${bytes.byteLength} bytes)...`;
  const started = performance.now();

  const result = await parseResume(bytes, 'harness-doc');
  const ms = Math.round(performance.now() - started);

  if (!result.ok) {
    log(`FAILED after ${ms}ms`, 'bad');
    log(`code:    ${result.error.code}`);
    log(`message: ${result.error.message}`);
    // The cause is what the swallowed catch would otherwise hide.
    log(`cause:   ${String((result.error as { cause?: unknown }).cause)}`, 'bad');
    return;
  }

  log(`OK in ${ms}ms`, 'ok');
  log(`scanned (no text layer): ${result.value.scanned}`);
  log(`pages: ${result.value.structured.pageCount}, lines: ${result.value.structured.lines.length}`);
  log(`sections: ${result.value.structured.sections.map((s) => s.type).join(', ')}`);
  log('\nscalars:');
  for (const [path, value] of Object.entries(result.value.scalars)) {
    log(`  ${path} = ${JSON.stringify(value.value)}`);
  }
  log(`\neducation: ${result.value.education.length}, employment: ${result.value.employment.length}`);
}

document.getElementById('file')?.addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file !== undefined) void file.arrayBuffer().then((bytes) => run(bytes, file.name));
});

document.getElementById('fixture')?.addEventListener('click', () => {
  void fetch('/fixtures/resumes/sample-resume.pdf')
    .then((response) => response.arrayBuffer())
    .then((bytes) => run(bytes, 'sample-resume.pdf'));
});

// Surface anything that escapes, which is what a bundling failure looks like.
window.addEventListener('error', (event) => log(`window error: ${event.message}`, 'bad'));
window.addEventListener('unhandledrejection', (event) =>
  log(`unhandled rejection: ${String(event.reason)}`, 'bad'),
);
