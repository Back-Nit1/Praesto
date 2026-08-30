# Security model

What this extension protects, what it does not, and the rules a change has to
follow to keep the guarantees true. Written during the security pass; every
`SECURITY:` comment in the source points back here.

## 1. Threat model

| Adversary | Can do | Cannot do (by design) |
|---|---|---|
| A hostile job-application page | Control every string the scanner reads (labels, options, URLs), re-render the DOM mid-fill, drive the page's own scripts | Read the applicant profile, call the service worker directly, cause a fill, read the extension's IndexedDB |
| Another installed extension | Send `chrome.runtime` messages (rejected: sender is checked), read anything the page exposes | Reach our storage or our content script's element map |
| Anyone who downloads the published extension | Read 100% of the shipped bundle, including every string literal in it | — |
| A local attacker with the user's unlocked profile | Read `chrome.storage.local` and IndexedDB | — |

The last two rows are the ones people get wrong, and both are addressed below.

## 2. Why an API key cannot live in the extension

**A published extension has no secrets.** The Chrome Web Store serves the CRX to
anyone; unzipping it is one command. Vite (and therefore WXT) **inlines**
`import.meta.env.*` at build time — the value becomes a string literal in a
`.js` file that every user has on disk.

```ts
// NEVER. This is not "reading a key from .env"; it is publishing the key.
const key = import.meta.env.VITE_ANTHROPIC_API_KEY;
```

A `.env` file keeps the key out of *git*. It does nothing about the *bundle*.

### The only architecture that works

```
extension  --(user credential)-->  your backend  --(API key)-->  model provider
```

- The API key lives in the backend's environment and never leaves it.
- The extension authenticates as *a user*, not as *the account* — a per-install
  token, or a real sign-in. Compromising one user's token costs one user's
  quota, not the whole key.
- Rate limiting and spend caps are enforced **server-side**. Client-side limits
  (see §5) are a courtesy to the user, not a control: anyone can edit the
  extension's own storage.
- The backend is the only place that should ever see resume text or profile
  values, and it should see the minimum needed to answer the question asked.

### Enforced mechanically

`npm run build` runs `scripts/check-bundle-secrets.mjs`, which fails the build
if anything key-shaped appears in `dist/`. It is a backstop, not a substitute.

## 3. Content Security Policy

`wxt.config.ts` sets, for extension pages:

- `script-src 'self'` — no remote code, no `eval`. (PDF.js is told
  `isEvalSupported: false` so it takes its non-eval path rather than throwing.)
- `object-src 'self'`
- `connect-src` — **the exfiltration control.** Production builds allow only
  `'self'`. When the chat feature lands, add *your backend origin only*. Do not
  add a model provider's origin: that would mean the key is in the client, which
  §2 rules out.
- `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`.

Dev builds additionally allow the WXT hot-reload websocket on localhost. That
relaxation is scoped to `mode !== 'production'` and never ships.

## 4. Trust boundaries

There are exactly three, and each has enforcement in code:

1. **Page → content script.** Every string the scanner reads is page-controlled.
   It is truncated at the source (`form-engine/detector/scanner.ts`) to the caps
   the message schema enforces, so a page cannot make a whole scan fail — or
   make the extension hold a megabyte label — by rendering absurd markup.
2. **Content script → service worker.** Validated by Zod
   (`shared/messages.ts`), *and* the sender is checked: a message whose
   `sender.id` is not our own extension id is dropped before parsing.
   Rate-limited per sender (§5).
3. **Side panel → content script.** The scanner checks `sender.id` too, and
   validates the payload shape rather than casting it. The resume it accepts is
   size- and type-capped before it is decoded.

The profile never crosses boundary 2 or 3. The page receives only the answers to
the questions it already displayed.

## 5. Rate limiting

`shared/rate-limit.ts` provides two, for two different jobs:

- `TokenBucket` — in-memory, O(1) per check, lazily refilled (no timers, so an
  idle limiter cannot keep the service worker awake). Guards the message
  boundary. `background.ts` uses it.
- `PersistentQuota` — storage-backed fixed window. **Required** for anything
  that costs money, because an in-memory counter resets every time MV3 evicts
  the service worker (~30s idle) — a caller need only pause between bursts to
  bypass it. Fails **closed**.

For the chat interface: client-side limits improve the UX (a clear "you've hit
today's limit" beats a 429). The enforceable limit is the backend's.

## 6. Data handling

- Profile → `chrome.storage.local`. Never `storage.sync`, which would replicate
  a home address to Google's servers.
- Resume bytes → IndexedDB, on this machine only.
- Neither is encrypted at rest. Chrome's profile directory is readable by any
  process running as the user; an encryption key the extension can use
  unattended would have to be stored beside the data, so it would add ceremony,
  not security. If that becomes unacceptable, the answer is a user-supplied
  passphrase, not a hidden key.
- Logs redact values by default and are off below `warn`. Failure **codes** are
  logged; failed **values** never are.
- `pageUrl` in a descriptor is stripped to origin + path. Query strings on ATS
  URLs routinely carry session and tracking tokens, and nothing downstream
  needs them.

## 7. Rules for future changes

1. No new permission without a written reason here. `<all_urls>` host access in
   particular would erase the `activeTab` posture the whole design rests on.
2. No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
   `eval`, or `new Function` anywhere. React's escaping is the only HTML sink.
3. No network call from the content script. Ever. It runs on a hostile origin.
4. Every new message type: Zod schema, length caps on every string, sender
   check, and a place in the rate limiter's budget.
5. Anything that spends money gets a `PersistentQuota` *and* a server-side cap.
6. Never log a profile value, a resume line, or a filled value.
