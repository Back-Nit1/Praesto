# Roadmap

**Written:** 2026-09-01. **Updated:** 2026-09-01, on landing items 1, 4, 5, 6, 7
and 8.
**Code at that date:** `npm run verify` clean, 732 tests. Phases 0–5 done, phase 6
done except for running against real applications, phase 7 not started, phase 8
partly done.

This file is an ordered list of what to build next and why that before anything
else. The other two files it sits next to:

- `IMPLEMENTATION_STATUS.md` — what exists.
- `gaps.md` — what the existing work does *not* prove.
- this file — what to do about the gaps.

Rules for using it:

- An item is only done when its **Done when** line is true.
- Anything you find while working on an item goes into `gaps.md`. Don't quietly
  absorb it.
- **Commit as you go.** Anything here that touches more than a couple of files
  should land as a series of small commits — one per working step — not one
  commit at the end. Easier to review, easier to revert.

Each item below has the same four parts: what to build, why it's a problem
today, where to look, and how you know you're finished.

---

## The short answer

Two left, in order, and both need something outside this repo:

1. Run the extension against real Greenhouse, Lever and Ashby applications.
2. Build the two backend endpoints: `/v1/semantic/concepts` and
   `/v1/semantic/option`.

Everything else that could be built without a real form or a server has been:
items 1, 4, 5, 6, 7 and 8 are done. Nothing further should be started before
item 2 — the whole point of it is that it changes what the rest of the list is
worth doing.

---

## Now

### 1. Split the audit outcome — before anything starts generating corrections

**DONE**, 2026-09-01 (`7bbb42b`, `3dfc4bf`). `FieldOutcome` replaces the boolean,
a correction is attributed to one run, and legacy rows read as
`corrected_legacy` and are counted in nothing. Two things turned up while doing
it and are fixed rather than absorbed: an upsert could erase a verdict the user
had just recorded, and accepting a suggestion produced a report indistinguishable
from an automatic fill, so the audit trail held no positive evidence at all.

**What.** Replace `FillAuditRecord.userCorrected: boolean` with a `FieldOutcome`
enum. Fix the double-count in `AuditRepository.markCorrected` (correcting the
same field twice in one run counts twice). Convert old rows when they're read.

**Why it's a gap.** One boolean is being asked to mean two opposite things:

- we filled a field with the wrong value, and
- we correctly left a field alone, and the user then told us what it means.

The first is a failure. The second is the product working. Right now they're the
same row. Worse, the distinction can't be recovered later — the information was
never written down — so every row created before this change is dead weight.
Item 2 is what starts creating those rows, so this has to land first.

**Where to look.** `src/packages/audit/types.ts:68`,
`src/packages/audit/repository.ts:113`. Steps 1–4 of the metrics brief.

**Done when.** Grepping for `userCorrected` finds only the comment on the
legacy-read path. The outcome is derived by a pure function with its own tests,
one named `does not count a user teaching us a blank field as an incorrect fill`.

**Size.** Small.

---

### 2. Run against real Greenhouse, Lever and Ashby applications

**What.** For each ATS: capture the real form as an anonymised fixture *first*,
then write a failing test, then fix the generic engine. Never a fix aimed at one
site.

**Why it's a gap.** Both layers of fixtures are markup we wrote ourselves —
`fixtures/forms/*.html` from our idea of what forms look like, and
`fixtures/forms/*-semantic.html` from each ATS's published naming conventions.
So the tests currently prove the engine agrees with our assumptions, not that it
agrees with reality. Only a real form can tell us where the assumptions are
wrong, and every item below this one is cheaper to do after that answer than
before it.

**Two numbers to write down while doing it**, because fixtures can't produce
them:

- How many resolver refusals the deterministic option scorer actually resolves.
  The 10-of-13 in `tests/semantic/option-match.test.ts` is measured against a
  corpus we invented. If the real number is much lower, the fix is a better
  scorer, not a bigger model quota — anything the scorer handles is free,
  private and instant.
- Which questions stage 1 misreads. A wrong concept isn't a wrong fill, but it
  adds junk rows to the review list, and a review list full of junk is one the
  user stops reading — which removes the one step the whole product is built
  around.

**Done when.** At least one anonymised fixture per ATS is in the repo, each with
a test, and every failure found is either fixed in the generic engine or written
into `gaps.md` with the reason it can't be.

---

### 3. The two backend endpoints

**What.** Implement `/v1/semantic/concepts` and `/v1/semantic/option` against the
schemas already written in `src/packages/backend/schemas.ts`.

**Why it's a gap.** They don't exist. Every request fails, `summariseRun` reports
`unavailable`, and the semantic fallback degrades to today's behaviour on every
field. That degradation is correct and tested — but it means the feature does
nothing in a real browser, and no request has ever travelled the full path from
question to filled field.

**Two things the implementation has to get right**, neither of which the client
can enforce:

- Keep the `untrusted` array structurally separate from the prompt's own
  instructions. That separation is what stops a job posting from injecting
  instructions into our prompt.
- Enforce quota server-side, per user. `PersistentQuota` in `chrome.storage` is
  a client-side courtesy — it resets when the user clears extension data, and
  anything with extension storage access can write to it. Design the server's
  quota now, while it's still a document and not a migration.

**Done when.** One real application is filled end to end through the model path,
with the run's cost recorded.

---

## Next

### 4. Show required fields that were left blank

**DONE**, 2026-09-01 (`81124b0`). A "Required, still blank" group above the
review list, covering three situations with the same next action: we did not
understand it, we offered a value nobody has accepted, or the page refused the
fill. A field the page had already answered is not listed.

**What.** Surface required-but-empty fields as their own thing in the panel.

**Why it's a gap.** `required` is captured by the scanner and typed on the
descriptor, and then nothing reads it. A required field we left blank lands in
the same "Left blank" bucket as an optional one — even though it's the single
most useful row for someone about to hit submit. Spec §33 asks for it directly.

**Where to look.** `src/packages/form-engine/detector/scanner.ts:309`,
`descriptor/types.ts:90`.

**Size.** Small, independent of everything above, shippable alone.

---

### 5. The three missing spec §25.2 fixtures

**DONE**, 2026-09-01 (`e31857a`). Found a real gap while writing the third:
`isVisible` read `element.hidden` on the control only, and a conditional question
is revealed by unhiding the BLOCK around it. It held in Chrome only because of
the UA stylesheet's `[hidden] { display: none }`, which a page is free to
override.

**What.** `education.html`, `employment.html`, `dynamic-dependent-question.html`.

**Why it's a gap.** §16 is the only spec section with no fixture at all, so the
dynamic one matters most — both limitation #6 (a revealed question needs a
click) and item 7 below depend on it. Education and employment would exercise
the multi-entry heuristic in `profile/selectors.ts`, which is unit-tested today
but has never been run through an actual form.

---

### 6. Let the user clear the concept cache, and show what a scan cost

**DONE**, 2026-09-01 (`271c462`). A settings screen, holding both, plus the
developer toggle. The scan-cost log is a time and a count per scan and nothing
else — history already records which forms were filled.

**What.** Two settings-screen additions: a button that calls
`SemanticConceptCache.clear()`, and a per-scan cost readout.

**Why it's a gap.** `clear()` exists and no UI calls it, so a wrong cached
concept sticks until the user wipes all extension data. And "how much of today's
budget did this form use" can't be answered from the UI at all — the panel stays
silent unless the fallback failed.

Both go on the settings screen, not the panel, for the reason the panel already
documents: a panel that reports its own internals on every scan is one the user
stops reading.

---

### 7. Rescan only the subtree that changed

**DONE**, 2026-09-01 (`3fd0f81`). Additions only: a field REMOVED from the page
still leaves its row, and a field that merely becomes required or enabled is not
noticed at all. Both are written into `gaps.md` §11 rather than left implied.

**What.** Build descriptors for new and changed controls instead of rescanning
the page (spec §16).

**Why it's a gap.** The `MutationObserver` signal is already wired; only the
incremental path is missing. So a conditional question that appears mid-form
costs a full rescan plus a user click.

**Must stay true.** Nothing gets filled because the page changed — only because
the user asked.

---

### 8. The metrics module

**DONE**, 2026-09-01 (`306b420`, `968da3b`) — ahead of item 2 rather than after
it, because the type split in item 1 had to land before any real corrections
were generated and the module is what proves that split works. It computes four
of the seven §26 metrics over whatever data exists; item 2 is what gives it data
worth reading.

**What.** The rest of the metrics brief, after item 1 lands and item 2 has
produced real rows to count. Ships behind the developer toggle §22 asks for,
which doesn't exist yet — build the toggle here.

**Why it's blocked until now.** Four of the seven §26 metrics become computable
once there's real data. The seventh (mapping precision) belongs to the fixture
corpus, not to user history. The reuse rate needs a semantic-cache-hit signal
nothing emits yet.

---

## Later

### 9. Define an ATS adapter seam, before Workday forces one

**What.** A per-ATS adapter interface in `src/packages/ats/`.

**Why it's a gap.** Phase 6 lists Greenhouse and Lever adapters as deliverables.
Neither exists, and that's fine so far — nothing has turned up that the generic
engine can't handle. But `src/packages/ats/` is only a detector and a type, and
the one adapter interface in the repo, `ControlAdapter`
(`fill-engine/types.ts:64`), is per-control, not per-ATS. So the MVP criterion
"ATS-specific code is isolated behind adapters" is true only because there is no
ATS-specific code yet.

Design the seam before Workday makes it urgent. Inventing it under pressure is
how ATS selectors end up in the generic mapper, which spec §28 forbids.

---

### 10. Phase 7 — Workday

Only after 1–3 are done and the generic engine has met real forms. Three
findings from research worth carrying in rather than rediscovering:

- **Workday dropdown option order changes per question.** A positional click can
  select "No" on *are you authorized to work?*. Type-ahead and verify the
  highlight; never select by index. Same failure class as the index-vs-label
  rule already enforced in `semantic/option-match.ts`.
- **Account creation comes first.** Workday makes you sign up before applying.
  Nothing in this codebase touches signup flows.
- **Each wizard step validates before it lets you continue.**

---

### 11. Phase 8 — free-response answer memory

**What.** Reuse the user's own past answers to open-ended questions.

**Why it's a gap.** It's the differentiator and the least specified thing in this
file. The design decisions live only in `gaps.md` §6 and a conversation
transcript: capture answers on fill plus a one-time import, reuse portable
answers verbatim, draft only from the user's own stored material, and use
separate types so a verbatim reuse may autofill while a composed draft never
may.

**Still undesigned.** Data flow, cold start on application #1 with an empty
corpus, the portable-vs-company-specific classifier, storage shape, testing.

Needs its own brief before any code, in the shape of `SEMANTIC_FILL_BRIEF.md`.

---

### 12. Reach: Shadow DOM, more ATSs, iframe proof

- **Shadow DOM.** No `shadowRoot` handling anywhere in `src/`, so a form built
  from web components reports "No application form detected" — wrong in kind, the
  same mis-wording already fixed for cross-origin iframes.
- **iCIMS, Taleo, SuccessFactors.** No detector, fixtures or adapters.
  SmartRecruiters has a detector (`ats/detector.ts`) and nothing else.
- **Cross-origin iframes are built** — `allFrames` injection, origin reporting,
  per-origin permission request — and have never been run against a real
  embedded application. Item 2 is where that gets tested.
- **SuccessFactors-family portals can drift silently.** An uploaded resume is
  parsed once and not reliably re-parsed, so the stored profile stops matching
  the file with no error shown. Where a portal has a "review your profile" step,
  show it as a required check instead of confirming that the upload succeeded.

---

### 13. Resume ingestion beyond the first format

DOCX, OCR for scanned PDFs and two-column layouts are all unimplemented — and
all detected and reported rather than guessed at, which is the right failure
mode. Multiple profiles and resume variants exist in the schema (`id`, `label`)
and not in the UI.

None of this blocks anything above it. Spec §30 says resume parsing must not
block the core engine; widening it shouldn't either.

---

## Open decisions that gate the roadmap

**Anti-bot exposure has never been assessed.** Synthetic mouse events,
native-setter writes and programmatic `DataTransfer` file injection are the exact
signals bot-detection systems look for. Nothing consulted so far covers CAPTCHA,
Cloudflare/PerimeterX, request pacing, or ATS terms of service. Item 2 is where
this first shows up — decide it there, on purpose, rather than finding out in
production.

One known case already: **Lever fires hCaptcha on programmatic checkbox and radio
clicks.** A known workaround is to fill text, textarea and native selects only,
and list the skipped controls for the user to tick by hand.

---

## Deliberately not on this roadmap

Written down so they don't get proposed again:

- **Auto-submit** (spec §21.4). Not in the initial product; the executor has no
  code path that clicks a submit button.
- **Generated cover letters and job-specific essays** as free-standing writing.
  Item 11 is the opposite: compose only from the user's own stored material, and
  return anything ungrounded as a gap for the user to fill, not as invented
  prose.
- **Cloud profile sync, multi-user, billing, analytics infrastructure** (spec
  §3.2). The local personal tool has to be useful first.
- **Browsers outside Chromium.**
- **A user-facing fill-rate number.** Spec §26 says raw fill rate is the wrong
  thing to optimise, and putting it on screen is how it starts getting optimised.
