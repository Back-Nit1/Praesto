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
