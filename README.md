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
npm run build      # -> dist/chrome-mv3   (load this folder in Chrome)
npm run dev        # dev build with hot reload
npm test           # 263 tests
npm run compile    # typecheck
npm run fixtures   # serve the practice forms at http://localhost:5174
```

### Load it in Chrome

1. **`npm run build`**
2. Open **`chrome://extensions`**
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the **`dist/chrome-mv3`** folder

   Full path on this machine:
   ```
   /Users/nityanthmaramreddy/applicanttool/dist/chrome-mv3
   ```
   In the file picker you can hit <kbd>⌘</kbd><kbd>⇧</kbd><kbd>G</kbd> and paste
   that path.
5. Pin the extension, click its icon, then **Edit your profile**.
6. Go to the **Resume** tab and upload your PDF. It reads your name, email,
   phone, location, links, education, experience and skills, shows you each
   value next to the line it came from, and adds only what you accept.
7. Check the **Profile** tab, fix anything that was read wrong, and answer the
   work-authorization questions — those are never inferred from a resume.

### Try it

```bash
npm run fixtures
```

Open <http://localhost:5174>, pick a form, click the extension icon, then
**Scan this page**. What each fixture is for:

| Fixture | What should happen |
|---|---|
| `basic-contact` | Everything fills. |
| `ambiguous-fields` | **Nothing** fills. The emergency-contact phone and the reference email are traps; the pre-filled email must be left untouched. |
| `radio-authorization` | Recognised, but never answered unless you set those answers yourself in the profile editor. |
| `native-select` | Country and state match — without picking *West Virginia* for *Virginia*. |

Then try the learning loop: on `ambiguous-fields`, click **Change** on a field,
tell it what that question means, and rescan.

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
- **Imports your resume** to bootstrap the profile, showing every extracted
  value next to the source line so you can check it before accepting
- **Attaches your resume** to the upload field automatically, so you never open
  a file picker again

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

## Your resume

Upload it once under **Edit your profile → Resume**. Two things then happen:

1. **It bootstraps your profile.** Text is extracted with layout preserved, so a
   date at the right of a job title is read as that job's date and a bullet is
   attached to the entry above it. Contact details are read from the **header
   block only** — a resume routinely contains a reference's email or a previous
   employer's city, and searching the whole document would find those about as
   often as yours. Nothing reaches your profile until you accept it on the
   review screen, and a verified value is never overwritten.

2. **It gets attached to applications.** The stored PDF is handed to the form's
   resume upload field, with the `change` event the form needs in order to
   notice. The matcher is deliberately narrow: a form usually has several file
   inputs, and attaching a resume to the cover-letter field sends an application
   you would never know was wrong. Cover letter, transcript, portfolio, writing
   sample and photo fields are all explicitly refused, and an unlabelled file
   input is left alone.

**Where the file goes: nowhere.** It is stored in this browser's IndexedDB on
this machine. There is no server in this project, so there is nothing for it to
be uploaded to. It is read back only to attach it to a form you are filling.

A scanned or image-only PDF has no text to read. The extension says so plainly
and still stores the file for attachment, rather than presenting an empty
extraction as a result.

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
    ├── resume-parser/       PDF extraction, layout reconstruction, extractors
    ├── form-engine/         detector, descriptor, fingerprints, mapper, resolver, confidence
    ├── fill-engine/         control adapters, native setter, executor
    ├── ats/                 ATS detection and adapter contracts
    └── learning/            learned mappings from your corrections

fixtures/forms/              HTML the tests run the real pipeline against
tests/                       263 tests, mostly browser-free
```

**Why the mapper never touches the DOM.** The content script converts elements
into plain `FieldDescriptor` objects, and everything downstream consumes those.
That single seam is why the entire intelligence of the product — mapping,
confidence, resolution — is testable in Node in milliseconds, from hand-written
objects, with no browser. It is also the privacy boundary: a descriptor contains
what the *page* said, never what *you* said.

---

## Seeing what changed

Every change to this project is a git commit with an explanation. Nothing is
edited in place without a record, so "what did the resume feature actually
touch?" is always answerable.

### The short version

```bash
git log --oneline                  # every change, newest first
git show --stat <hash>             # which files one change touched
git show <hash>                    # the full diff, with the reasoning at the top
git log -p -- src/packages/x.ts    # the history of one file
git diff                           # what is changed but not yet committed
```

### Walking through a real example

The resume feature is commit `e7e3242`. To see what it did:

```bash
git show --stat e7e3242            # 22 files: the parser, the store, the UI
git show e7e3242 -- src/packages/resume-parser/pdf/extract.ts
```

The commit message says *why*, the diff says *what*, and the file's own header
comment says *how it works and what it deliberately does not do*. Those three
are meant to be read together — if a change is not obvious from the diff, the
explanation is in one of the other two.

### Finding when something appeared

```bash
# Which commit introduced resume attachment?
git log --oneline -- src/packages/fill-engine/adapters/file-upload.ts

# Search commit messages
git log --oneline --grep resume

# Who last touched each line of a file, and in which commit
git blame src/packages/form-engine/mapper/resume-field.ts
```

### Reading it in a UI instead

```bash
gitk                       # ships with git
git log --oneline --graph  # a graph in the terminal
```

VS Code's built-in Source Control panel and its Timeline view (right-click a
file → *Open Timeline*) show the same history without the command line.

### Conventions

Commit subjects are prefixed by what the change is:

| Prefix | Meaning |
|---|---|
| `feat:` | new capability |
| `fix:` | corrected behaviour — the message names the bug and how it would have shown up |
| `test:` | tests, and any bug they caught |
| `docs:` | documentation only |
| `build:` / `chore:` | tooling and packaging |

Commit bodies explain **why**, not just what. A `fix:` in particular says what
the wrong behaviour would have looked like to a user, because that is the part
you cannot recover from the diff later.

### If more than one person (or agent) is working here

Commits can land that you did not make. To see them:

```bash
git log --oneline -10      # what has landed recently
git status                 # what is changed in your working tree right now
git diff HEAD              # everything uncommitted, including staged
```

`IMPLEMENTATION_STATUS.md` is the running summary of where the project stands —
what is built, what is not, known limitations, and the next recommended task. It
is updated with the work, so it is the fastest way to catch up without reading
the log.

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
