# Roadmap

**Written:** 2026-09-01.
**Status of the code at that date:** `npm run verify` clean, 665 tests, phases
0–5 done, phase 6 done except for real applications, phase 7 not started,
phase 8 partly done.

This file answers one question: *what is next, and why that rather than
something else.* It is ordered. `IMPLEMENTATION_STATUS.md` says what exists,
`gaps.md` says what the existing work does not establish, and this file says
what to do about it.

Rule for using it: an item moves only when its **definition of done** is met,
and anything discovered while doing it goes into `gaps.md` rather than being
absorbed silently.

---

## The short answer

**Next up, in order:**

1. Split the audit `userCorrected` flag into a `FieldOutcome` (small, and it
   has to happen before real corrections start accumulating).
2. Run against real Greenhouse, Lever and Ashby applications.
3. Stand up `/v1/semantic/concepts` and `/v1/semantic/option`.

Everything after that is genuinely optional until those three are done.

---

## Now

### 1. Audit outcome split — before anything generates corrections

**What.** Replace `FillAuditRecord.userCorrected: boolean`
(`src/packages/audit/types.ts:68`) with a `FieldOutcome`, fix the per-run
double-count in `AuditRepository.markCorrected`
(`src/packages/audit/repository.ts:113`), and normalise legacy rows on read.

**Why now, rather than with the metrics view it serves.** The boolean cannot
tell "we filled a field wrongly" apart from "we correctly refused a field and
the user taught us what it means". Those are opposite signals, and the first is
the failure the product exists to avoid. Every row written before the split is
unrecoverable — the information was never captured — so the split has to land
before item 2 starts producing real corrections.

**Definition of done.** Grep for `userCorrected` returns only the
legacy-read comment. The derivation is a pure function with its own tests, one
of them named `does not count a user teaching us a blank field as an incorrect
fill`.

**Size.** Small. Steps 1–4 of the metrics brief.

---

### 2. Run against real Greenhouse, Lever and Ashby applications

**What.** Capture each real form as an anonymised fixture **first**, then a
failing test, then a fix in the generic engine — never a fix aimed at a site.

**Why it is the highest-value item on the page.** Both fixture layers are
markup *we* wrote: `fixtures/forms/*.html` from what we believe forms look
like, and `fixtures/forms/*-semantic.html` from each ATS's published naming
conventions. They encode a belief. Only a real form can say where the belief is
wrong, and every item below is cheaper to do correctly after that answer than
before it.

**Two numbers to record while doing it**, because the fixtures cannot produce
them:

- How many resolver refusals the deterministic option scorer actually settles.
  The 10-of-13 figure in `tests/semantic/option-match.test.ts` is measured
  against a corpus we invented. A much lower real number argues for a better
  scorer, not a bigger model quota — every case the scorer settles is free,
  private and instant.
- Which questions stage 1 gets wrong. A wrong concept is not a wrong fill, but
  it is noise in the review list, and noise trains the user to click through
  without reading — which destroys the one step the product is built around.

**Definition of done.** At least one anonymised fixture per ATS in the repo, a
test per fixture, and every failure found either fixed in the generic engine or
written into `gaps.md` with the reason it cannot go there.

---

### 3. The two backend endpoints

**What.** `/v1/semantic/concepts` and `/v1/semantic/option`, implemented
against the schemas already written in `src/packages/backend/schemas.ts`.

**Why.** They do not exist. Every request fails, `summariseRun` reports
`unavailable`, and the semantic fallback degrades to exactly today's behaviour
on every field. That degradation is correct and is tested — and it means the
feature currently does nothing in a real browser, and no end-to-end path from
question to filled field has ever executed.

**Two things that must be true of the implementation**, neither enforceable
from the client:

- The prompt keeps the `untrusted` array structurally separate from its own
  instructions. That separation is the whole prompt-injection defence.
- Quota is enforced **server-side, per user**. `PersistentQuota` in
  `chrome.storage` is a client-side courtesy: it resets when the user clears
  extension data and is writable by anything with extension storage access.
  Design the endpoint's quota now, while it is still a document.

**Definition of done.** One real application filled end to end through the
model path, with the run's cost recorded.

---

## Next

### 4. Surface required-but-blank fields

`required` is captured (`src/packages/form-engine/detector/scanner.ts:309`),
typed (`descriptor/types.ts:90`), and read by nothing. A required field left
blank sits in the same "Left blank" bucket as an optional one — and it is the
single most valuable row in the panel for someone about to press submit. Spec
§33 lists it explicitly.

Small, independent of everything above, and shippable on its own.

---

### 5. The three missing spec §25.2 fixtures

`education.html`, `employment.html`, `dynamic-dependent-question.html`.

The dynamic one matters most: §16 is the only spec section with no fixture at
all, and both limitation #6 (a revealed question needs a click) and item 7 below
depend on it. The education and employment fixtures would exercise the
multi-entry heuristic in `profile/selectors.ts` — currently unit-tested, never
tested through a form.

---

### 6. Let the user see and clear the concept cache; show what a scan cost

`SemanticConceptCache` has `clear()` and no UI calls it, so a wrong cached
concept has no escape short of clearing all extension data. Separately, "how
much of my daily budget did this form cost" is unanswerable from the UI — the
panel is deliberately silent unless the fallback failed.

Both belong on the settings screen rather than in the panel, for the reason the
panel already documents: a panel that narrates its own internals every scan is
one the user stops reading.

---

### 7. Incremental rescan of a revealed subtree

The `MutationObserver` signal is wired; only the incremental path is missing, so
a conditional question costs a full rescan and a click. Spec §16 asks for
descriptors to be created for new and changed controls only.

The behaviour that must survive: nothing is filled because the page changed,
only because the user asked.

---

### 8. The metrics module itself

The remaining steps of the metrics brief, once item 1 has landed and item 2 has
generated real rows to count. Four of the seven §26 metrics become computable;
the seventh (mapping precision) belongs to the fixture corpus rather than to
user history, and the reuse rate needs a semantic-cache-hit signal that does not
exist yet.

Ships behind the developer toggle §22 asks for and which does not exist yet —
build the toggle here.

---

## Later

### 9. An ATS adapter seam, before Workday needs one

Phase 6 lists Greenhouse and Lever adapters as deliverables. Neither exists, and
correctly so: nothing has yet been found that the generic engine cannot handle.
But `src/packages/ats/` is a detector and a type, and the only adapter interface
in the repo is `ControlAdapter` (`fill-engine/types.ts:64`), which is
per-control, not per-ATS. The MVP criterion "ATS-specific code is isolated
behind adapters" is currently true only because there is no ATS-specific code.

Define the seam before Workday forces it. Inventing it under Workday pressure is
how ATS selectors end up in the generic mapper, which spec §28 forbids.

---

### 10. Phase 7 — Workday

Only after 1–3 are done and the generic engine has met real forms. Three
findings from research worth carrying in rather than rediscovering:

- **Workday dropdown option order varies per question**, so a positional click
  can select "No" on *are you authorized to work?*. Type-ahead and verify the
  highlight; never select by index. Same class of failure as the index-vs-label
  rule already enforced in `semantic/option-match.ts`.
- **Account creation comes first.** Workday requires signup before applying,
  which is a surface nothing in this codebase touches.
- **Per-step validation gating** in the multi-step wizard.

---

### 11. Phase 8 — free-response answer memory

The differentiator, and the least specified thing here. The design decisions
exist only in `gaps.md` §6 and in a conversation transcript: capture on fill
plus a one-time import, verbatim reuse for portable questions, drafting only
from the user's own stored specifics, and separate types so a verbatim reuse may
autofill while a composed draft never may.

**Undesigned:** data flow, cold start on application #1 with an empty corpus,
the portable-vs-company-specific classifier, storage shape, testing.

Needs its own brief before any code, in the shape of `SEMANTIC_FILL_BRIEF.md`.

---

### 12. Reach: Shadow DOM, more ATSs, iframe proof

- **Shadow DOM traversal.** No `shadowRoot` handling anywhere in `src/`. A
  web-component form currently reports "No application form detected", which is
  wrong in kind — the same mis-wording already fixed for cross-origin iframes.
- **iCIMS, Taleo, SuccessFactors.** No detector, fixtures or adapters.
  SmartRecruiters has a detector (`ats/detector.ts`) and nothing else.
- **Cross-origin iframes are implemented** — `allFrames` injection, origin
  reporting, per-origin permission request — and have never been proven against
  a real embedded application. Item 2 is where that gets tested.
- **SuccessFactors-family portals can silently diverge**: an uploaded resume is
  parsed once and not reliably re-parsed, so the stored profile drifts from the
  file with no error shown. Where a portal offers a "review your profile" step,
  surface it as a required check rather than confirming upload success.

---

### 13. Resume ingestion beyond the first domain

DOCX, OCR for scanned PDFs, and two-column layouts are all unimplemented and all
detected-and-reported rather than guessed at. Multiple profiles and resume
variants are in the schema (`id`, `label`) and not in the UI.

None of this blocks anything above it. Spec §30 is explicit that resume parsing
must not block the core engine, and the same logic applies to widening it.

---

## Decisions that gate the roadmap and are not yet made

**Anti-bot exposure has never been assessed.** Synthetic mouse events,
native-setter writes and programmatic `DataTransfer` file injection are exactly
the fingerprint bot-detection systems look for. Nothing consulted so far
addressed CAPTCHA, Cloudflare/PerimeterX, request pacing, or ATS terms-of-service
exposure. Item 2 is the first place this surfaces; decide it deliberately there
rather than discovering it in production.

One known instance already: **Lever fires hCaptcha on programmatic checkbox and
radio clicks.** A working approach elsewhere is to fill text, textarea and native
selects only, and list the skipped controls for the user to tick by hand.

---

## Not on this roadmap, deliberately

Recorded so they are not re-proposed:

- **Auto-submit.** Spec §21.4. Not in the initial product, and the executor has
  no code path that clicks a submit button.
- **Generated cover letters and job-specific essays** as free-standing
  generation. Item 11 is the opposite of this: composition strictly from the
  user's own stored material, with anything ungrounded returned as a gap to
  fill rather than as invented prose.
- **Cloud profile sync, multi-user, billing, analytics infrastructure.** Spec
  §3.2. The local personal tool has to be useful first.
- **Browsers outside Chromium.**
- **A user-facing fill-rate number.** Spec §26 says raw fill rate is the wrong
  thing to optimise, and putting it on screen is how it starts being optimised.
