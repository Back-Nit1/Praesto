#!/usr/bin/env node
/**
 * Serve the test fixtures over http, for trying the extension by hand.
 *
 *     npm run fixtures      ->  http://localhost:5174
 *
 * WHY A SERVER RATHER THAN JUST OPENING THE FILES
 * Chrome does not give extensions access to `file://` URLs unless the user
 * turns on "Allow access to file URLs" per extension, which is an obscure
 * toggle and an unpleasant first-run instruction. More importantly, a `file://`
 * page is not representative: it has a null origin and different security
 * behaviour, so testing there proves less than it appears to.
 *
 * Deliberately dependency-free (node:http only) and localhost-bound. This is a
 * development convenience, not part of the extension, and nothing here should
 * ever be reachable from another machine.
 */
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const PORT = Number(process.env.PORT ?? 5174);
const ROOT = resolve(process.cwd(), 'fixtures/forms');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** Simple index so there is somewhere to land. */
async function indexPage() {
  const files = (await readdir(ROOT)).filter((name) => name.endsWith('.html')).sort();

  const items = files
    .map((name) => `<li><a href="/${name}">${name.replace('.html', '')}</a></li>`)
    .join('\n      ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Application fixtures</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }
      li { margin: .4rem 0; }
      code { background: #f4f4f5; padding: .1rem .3rem; border-radius: .2rem; }
    </style>
  </head>
  <body>
    <h1>Application fixtures</h1>
    <p>
      Open one, click the extension icon, then <strong>Scan this page</strong>.
      Fill in your profile first via <em>Edit your profile</em>.
    </p>
    <ul>
      ${items}
    </ul>
    <h2>What to look for</h2>
    <ul>
      <li><code>basic-contact</code> — everything should fill.</li>
      <li><code>ambiguous-fields</code> — nothing should fill. The emergency
        contact phone and the reference email are traps; the prefilled email
        must be left alone.</li>
      <li><code>radio-authorization</code> — recognised but never answered
        unless you set those answers in your profile yourself.</li>
      <li><code>native-select</code> — country and state must match without
        picking West Virginia for Virginia.</li>
    </ul>
  </body>
</html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': MIME['.html'] });
    response.end(await indexPage());
    return;
  }

  // Path traversal guard. Trivial for a localhost dev server, but a served
  // directory plus unvalidated user input is a pattern worth never writing,
  // even where the blast radius is small.
  const requested = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (!requested.startsWith(ROOT)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(requested);
    response.writeHead(200, {
      'content-type': MIME[extname(requested)] ?? 'application/octet-stream',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': MIME['.html'] });
    response.end('<h1>404</h1><p><a href="/">Back to the fixture list</a></p>');
  }
});

// Bound to loopback explicitly: this serves local files and must not be
// reachable from the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Fixtures at http://localhost:${PORT}`);
});
