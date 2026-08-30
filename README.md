# Personal Job Application Agent

A Chrome extension that fills job applications from a profile you have verified
yourself — and leaves blank anything it is not sure about.

The design goal is stated in one line in `prompt.md`, and every decision in this
codebase follows from it:

> **Optimize for incorrect fills approaching zero, not fields-filled approaching 100%.**
>
> A field left blank is recoverable. A confidently filled wrong answer is not.

That is the opposite of how most autofill tools are tuned. It means this
extension will sometimes fill fewer fields than a competitor while being worth
trusting — you can stop proofreading your own email address, and still know it
will stop and ask when it genuinely does not know.

---

## Quick start

```bash
npm install
npm run dev        # dev build with hot reload
npm run build      # production build -> .output/chrome-mv3
npm test           # 206 tests
npm run compile    # typecheck
```

**Load it in Chrome:**

1. `npm run build`
2. Open `chrome://extensions`
3. Turn on **Developer mode**
4. **Load unpacked** → select `.output/chrome-mv3`
5. Click the extension icon → **Edit your profile** → fill in your details
6. Open a job application, click the extension icon, then **Scan this page**

Nothing is filled until you click **Fill safe fields**, and the extension never
submits an application.

---

## What it does today

- Detects application fields on any page, without site-specific selectors
- Maps them to a canonical profile using HTML semantics, a curated alias
  registry, and fuzzy matching — **no network, no LLM, no API key**
- Fills only what it is confident about, and **verifies the value landed** by
  reading the control back
- Leaves ambiguous fields alone and surfaces them for review
- Never answers a work-authorization or demographic question from anything but
  an answer you gave it explicitly
- **Learns from your corrections.** Fix a field once and it maps that question
  correctly on every future application — even where the HTML is completely
  different

See [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) for what is built,
what is not, and what is next.

---

## How it works

The pipeline is five stages, and each is a pure function except the one that
loads your profile:

```
job application page
        │
        ▼
  ┌───────────┐   finds controls, describes them as plain data
  │  scanner  │   (content script — the only DOM-aware module)
  └─────┬─────┘
        │  FieldDescriptor[]   ← the page's own words. No applicant data.
        ▼
  ┌───────────┐   "what is this field ASKING for?"
  │  mapper   │   → a canonical path like "contact.email"
  └─────┬─────┘
        │  FieldMappingResult
        ▼
  ┌───────────┐   "what exact representation does THIS control need?"
  │ resolver  │   → "(609) 555-1234" or "6095551234" or "609"
  └─────┬─────┘
        │  ResolvedValue
        ▼
  ┌───────────┐   "am I confident enough to act?"
  │  policy   │   → autofill | suggest | skip
  └─────┬─────┘
        │  ResolvedFieldAction[]   ← only the values these fields need
        ▼
  ┌───────────┐   drives the control, then reads it back
  │fill engine│
  └───────────┘
```

### The four ideas that make it trustworthy

**1. Every value carries its provenance.**
Applicant facts are never stored as bare strings. Each one is a `ProfileValue<T>`
holding the value, the raw source text, and a list of evidence — where it came
from, how confident we are, and whether *you* confirmed it. A bare string cannot
express the difference between "the user typed this" and "a parser guessed
this", so a codebase built on bare strings cannot keep the promise this product
makes. Wrapping the value makes the distinction structural rather than a
convention someone has to remember.

**2. Mapping confidence and value confidence are separate numbers.**
Being certain a field asks for a phone number does not license filling it with a
number you have never looked at. Both must clear their own bar. Averaging them
into one score would let a strong mapping paper over an unverified value.

**3. The five knowledge states never collapse into a guess.**

```
I KNOW this.                    → fill it
I can DERIVE this.              → fill it
I have SEEN you answer this.    → fill it
I THINK this is probably right. → show it, do not fill it
I DON'T KNOW.                   → leave it alone, tell you about it
```

**4. Your corrections outrank our heuristics.**
Correcting a field stores a rule keyed on a *semantic fingerprint* — a hash of
what the question SAYS, not of the markup around it. So a correction made on a
Greenhouse form applies on a Lever form asking the same thing, even though the
two share no ids, classes, or structure. A user-confirmed rule beats the alias
registry outright, because you are the authority on your own application and a
table we wrote is not. You choose how widely each correction applies
(everywhere / this platform / this company / just this field), and every rule is
listed, with its track record, under **Learned rules** in the options page.

**5. Legal and demographic answers are never inferred.**
Work authorization, sponsorship, citizenship, gender, race, disability and
veteran status can only come from an answer you gave in the profile editor.
Never from your name, your university, your address, or a language on your
resume. This is enforced by `SENSITIVE_PATHS` in the confidence policy, not by a
comment asking people to remember.

---

## Privacy

- **Everything stays on your computer.** `chrome.storage.local`, not
  `storage.sync` — your address and phone number are not replicated to Google's
  servers as a side effect of using this.
- **No API keys, anywhere.** Factual autofill does not use a model, so there is
  nothing to key. If semantic fallback is added later it will go through a
  backend; the extension will never hold a provider credential.
- **The webpage never receives your profile.** The content script sends
  descriptors for the fields it found and receives values for *those fields
  only*. Even if a page compromised the content script, the most it could learn
  is the answers to the questions it already displayed.
- **Minimal permissions.** `storage`, `sidePanel`, `scripting`, `activeTab`.
  The built manifest declares **no host permissions and no content scripts** —
  so Chrome does not show the "read and change all your data on all websites"
  warning at install. The page scanner is injected into one tab, by your click,
  under `activeTab`. Your click is the grant.
- **It never submits an application.**

---

## Layout

```
src/
├── entrypoints/
│   ├── background.ts        service worker: coordination, profile access
│   ├── scanner.ts           page context: scan, fill, verify (injected on demand)
│   ├── sidepanel/           the review surface you work in
│   └── options/             profile editor + mapping playground
└── packages/
    ├── shared/              Result, errors, ids, logging, messages, runtime budget
    ├── storage/             KeyValueStore, IndexedDB, migrations
    ├── profile/             schema, normalizers, paths, selectors, repository
    ├── form-engine/         detector, descriptor, fingerprints, mapper, resolver, confidence
    ├── fill-engine/         control adapters, native setter, executor
    ├── ats/                 ATS detection and adapter contracts
    └── learning/            learned mappings from your corrections

fixtures/forms/              HTML the tests run the real pipeline against
tests/                       206 tests, mostly browser-free
```

**Why the mapper never touches the DOM.** The content script converts elements
into plain `FieldDescriptor` objects, and everything downstream consumes those.
That single seam is why the entire intelligence of the product — mapping,
confidence, resolution — is testable in Node in milliseconds, from hand-written
objects, with no browser. It is also the privacy boundary: a descriptor contains
what the *page* said, never what *you* said.

---

## Working on it

**The regression loop** (from `prompt.md` section 25.3) is not optional — it is
how this codebase is meant to improve:

```
a real application misbehaves
        ↓
add its markup to fixtures/forms/
        ↓
write the failing test
        ↓
fix the GENERIC engine (or, only if unavoidable, an ATS adapter)
        ↓
keep the regression forever
```

Prefer adding an alias in `form-engine/mapper/aliases.ts` over loosening the
fuzzy matcher. An alias is a precise, permanent fix; loosening the threshold
trades one fixed field for an unknown number of new mismatches.

**Debugging a mapping.** Open the options page → *Mapping playground*. Type in
the label, `name`, `autocomplete` and control type, and see the prediction,
confidence, every contributing reason, the resolved value, and the semantic
fingerprint. It runs the real pipeline, so what you see is what the extension
does. This is much faster than reloading a live ATS page, and it is usually the
right first step when a learned correction fails to carry over — check whether
the two questions actually produce the same fingerprint.

**Adding a control type.** Write a `ControlAdapter` in
`fill-engine/adapters/`, register it before the more general adapters, and give
it a `verify` that genuinely reads the control back. A fill is not successful
because no exception was thrown.

---

## Non-goals

Auto-submitting applications. Mass or automated applying. Scraping LinkedIn.
Cloud sync of your profile. Generating essay answers before factual autofill is
reliable. Building Workday support before the generic engine is proven.
