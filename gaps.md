# Gaps in the semantic fallback

**Written:** 2026-08-31, on landing `SEMANTIC_FILL_BRIEF.md`.
**Status of that work:** steps 1–7 of the brief's §9 are done and committed;
`npm run verify` is clean at 665 tests. This file is the other half of that
sentence — what the work does **not** establish.

It exists because the product's entire claim is that it does not overstate what
it knows, and a subsystem that asks a language model to read job-application
questions is exactly the place where that claim is easiest to quietly break.
`IMPLEMENTATION_STATUS.md` carries these as numbered limitations; this file says
them in one place, with what it would take to close each.

---

## 1. It has never run against a real application

**The gap.** Every fixture in `fixtures/forms/*-semantic.html` is markup *we*
wrote from each ATS's published naming conventions. Nothing was captured from a
real Greenhouse, Lever or Ashby form. Every test runs against
`FakeSemanticPort`.

So what is proven is that the pipeline handles the **shape** of that markup and
that the modules honour their own contracts. It is not proven that it handles
Greenhouse.

**Why it matters more here than elsewhere.** `engineering.md` already lists
"tests are all against markup we wrote ourselves" as a standing weakness, and
the mapper has survived it because an alias table is cheap to correct. This
layer is different: a wrong concept costs a model call, enters the review list,
and — if it is wrong often — trains the user to click through the review list
without reading, which destroys the one step the whole product is built around.

**To close it.** Acceptance criterion #2 of the brief. Capture each real form as
an anonymised fixture **before** fixing anything against it, then a failing
test, then a fix in the generic engine. Two numbers to record while doing it:

- **How many refusals the deterministic scorer actually settles.** The 10-of-13
  figure in `tests/semantic/option-match.test.ts` is measured against a corpus
  we invented. If the real number is much lower, the answer is a better scorer,
  not a bigger quota — every case it settles is free, private and instant.
- **Which questions stage 1 gets wrong.** A wrong concept is not a wrong fill,
  but it is noise, and noise is what the point above is about.

---

## 2. The backend endpoints do not exist

**The gap.** `/v1/semantic/concepts` and `/v1/semantic/option` are fully
specified by the schemas in `backend/schemas.ts` and are not implemented
anywhere. No shipped build sets `WXT_BACKEND_ORIGIN` — it has been set once, in
a throwaway build made only to confirm the origin reaches the manifest's
`connect-src`.

**What that means today.** Every request fails, `summariseRun` reports
`unavailable`, and every field keeps the refusal the deterministic pipeline
already gave it. That is correct behaviour and it is tested — but it means the
feature currently does nothing in a real browser, and no end-to-end path from
question to filled field has ever executed.

**To close it.** Stand up the two endpoints against the schemas as written. The
prompt on the backend side must keep the `untrusted` array structurally separate
from its own instructions; that separation is the entire prompt-injection
defence and the client cannot enforce it alone.

---

## 3. The option scorer is deliberately weak in the middle

**Not a defect — a calibration, recorded here so it is not "fixed" by accident.**

`option-match.ts` settles exact matches, case and punctuation differences,
reordered labels ("Computer Engineering" / "Engineering, Computer") and guarded
containment. It has **no general similarity tier**, because any Jaccard or
edit-distance threshold that admits the good cases also admits "Virginia"
against "West Virginia" — and the failure that produces is not a blank field but
a confident wrong one, on a job application.

**What it costs, concretely.** A single-token value against a longer option
("Rutgers" against "Rutgers University - Newark") always escalates to a model
call. So does every numeric value against a range dropdown ("4" against
"3-5 years"). Both are common.

**If you change this,** the test named `does NOT select West Virginia for an
applicant in Virginia` is the one that must keep passing. It is named after the
bug, not after the function.

---

## 4. The guard that actually holds is not the obvious one

A **finding**, not a gap, but the most load-bearing thing on this page.

On the semantic route, what stops a work-authorization question from autofilling
is the **confidence cap** (`sourceScores.semantic` = 0.80, below
`autofillThreshold` = 0.95) — **not** `requiresVerifiedValue`. The
sensitive-path gate deliberately permits a value the user typed themselves,
which is the whole point of storing one.

Verified by mutation: raising `sourceScores.semantic` to 0.99 turns all four
sensitive-field tests in `tests/semantic/safety.test.ts` into autofills.

**So:** that number is a safety control, not a tuning knob. Raising it to
"improve coverage" would silently make the extension answer legal questions on
someone's behalf. `tests/semantic/safety.test.ts` says this in as many words and
pins the number directly.

---

## 5. Smaller gaps

- **Cache eviction is oldest-first, not LRU.** LRU needs a write on every read,
  and the cache is read on the hot path of every scan — which would turn a free
  cache hit into a storage write. At the 500-entry cap the difference is
  theoretical, but a user who meets 500 novel questions starts paying again for
  their oldest ones.
- **A cached concept is never re-examined.** If a model's answer was wrong, the
  user corrects the field once and the existing learned-mapping path takes over
  at higher confidence — but the wrong cached entry stays. `SemanticConceptCache`
  has `clear()`; no UI calls it.
- **Nothing shows the quota on a successful scan.** The panel is silent unless
  the fallback failed, which is deliberate — a panel that narrates its own
  internals every scan is one the user stops reading. But "how much of my daily
  budget did this form cost" is unanswerable from the UI.
- **`applyUpdates` is covered by no test at all.** The reasoning moved into
  `@semantic/apply.ts` precisely so it could be tested, but the translation into
  `ResolvedFieldAction` and `PendingFieldAudit` stayed in `background.ts`, which
  has no unit test and is not reached by `e2e/fill.spec.ts`. It writes the
  action and the history row together — if those two ever disagree, nothing
  currently fails.

---

## 6. The free-response subsystem is designed only to its first section

Decided in conversation on 2026-08-31. **Not written to a spec, not
implemented.** Recorded here because the decisions are the expensive part and
they currently exist only in a transcript.

What was settled:

- **Capture on fill, plus import.** Praedos captures a free-response answer when
  it is already active on the page, plus a one-time import of past cover
  letters. Stays on `activeTab` — no always-on content script, no new
  permission. Always-on passive capture was considered and rejected: it needs
  the broad host permission `wxt.config.ts` deliberately avoids.
- **Reuse verbatim, draft the rest.** Portable questions ("describe a hard
  problem you solved") refill with the user's exact past words, with no model
  involved. Company-specific questions ("why us") produce a draft.
- **Compose only from the user's own material.** The drafting step may assemble
  and adapt what the user has actually written; anything it cannot ground in a
  stored specific comes back as a **gap to fill**, never as invented prose. This
  is the refusal architecture applied to writing.
- **A verbatim reuse may autofill; a composed draft never may** — enforced by
  separate types, not by a threshold.

Two stores are implied and should not be collapsed: the user's **answers**
verbatim (the retrieval corpus and the voice sample set) and the **specifics**
extracted from them, each carrying a provenance pointer. That pointer is the
anti-slop mechanism — a sentence may only be emitted if a specific backs it.

**Still undesigned:** data flow, cold start on application #1 with an empty
corpus, the portable-vs-company-specific classifier, storage shape, testing.

**Why it matters:** this is the differentiator. Competitors produce generic AI
prose; the claim here is that output is provably made of the user's own
sentences. That claim is only worth making if the grounding is real.

---

## 7. Surfaces nobody has implemented — here or anywhere

From competitive research on 2026-08-31. No open-source tool examined implements
any of these either, which makes them the opportunity as much as the gap.

| Surface | State |
|---|---|
| Workday multi-step wizard | Not started (Phase 7). Per-step validation gating |
| Account creation | Not started. Workday requires signup before applying |
| Shadow DOM traversal | Not implemented anywhere in the codebase |
| Cross-origin iframes | Not implemented. Some enterprise ATS embeds use them |
| iCIMS, Taleo, SmartRecruiters, SuccessFactors | No detector, fixtures or adapters |

Three findings worth carrying into Phase 7 rather than rediscovering:

- **Workday dropdown option order varies per question**, so a positional click
  can select "No" on *are you authorized to work?*. Type-ahead and verify the
  highlight; never select by index. This is the same class of failure as the
  index-vs-label rule already enforced in `semantic/option-match.ts`.
- **Lever fires hCaptcha on programmatic checkbox and radio clicks.** A working
  approach elsewhere is to fill text, textarea and native selects only, and list
  the skipped controls for the user to tick by hand.
- **SuccessFactors-family portals can silently diverge** — an uploaded resume is
  parsed once and not reliably re-parsed, so the portal's stored profile drifts
  from the file with no error shown. Where a portal offers a "review your
  profile" step, surface it as a required check rather than confirming upload
  success.

---

## 8. Anti-bot exposure has never been assessed

Synthetic mouse events, native-setter writes and programmatic `DataTransfer`
file injection are precisely the fingerprint bot-detection systems look for. No
source consulted addressed CAPTCHA, Cloudflare/PerimeterX, request pacing, or
ATS terms-of-service exposure.

Recorded as an unexamined risk under the whole product, not as a task. It should
be decided deliberately rather than discovered in production. Gap #1 is the
first place it will surface.

---

## 9. Process: parallel agents duplicated a whole subsystem

On 2026-08-31 a subagent was dispatched to implement §9 steps 1–4 of
`SEMANTIC_FILL_BRIEF.md` in a worktree while the full seven-step implementation
was already landing on `main` from another session. The branch conflicted
add/add on every file and was discarded. Separately, this file was overwritten
rather than merged, and recovered from `c95f05c`.

**To avoid:** read `git log main` immediately before dispatching an agent
against a written brief and again before merging its branch — and read any file
before writing over it, however new it looks.

---

## What is NOT a gap

Recorded so these are not re-litigated:

- **Workday.** Out of scope by decision #3 of the brief. The option-matching
  engine was the risky new part and it was proven where the DOM is easy.
- **Free-text answer generation** (spec Phase 8's later half). Approving,
  editing and reusing written answers is not built. `prompt.md` §27 is explicit
  that open-ended answers must not be fabricated, and nothing here does.
- **The extension asking for host permissions.** It does not, and did not start
  to. The built manifest still declares no `host_permissions`; `connect-src` is
  pinned to the compiled-in origin and nothing else.
