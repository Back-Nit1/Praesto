# Gaps

Open gaps as of 2026-08-31. This file records what is **missing, unverified or
undecided** — the complement to `IMPLEMENTATION_STATUS.md`, which records what
is done. Where the status file already states a limitation honestly, this file
does not repeat it; it points at it and says what would close it.

Ordered by what blocks the most.

---

## 1. Nothing has ever run against a real job application

The semantic fallback, the fill engine, the option scorer and every ATS fixture
are tested against **markup we wrote ourselves**. `IMPLEMENTATION_STATUS.md`
says this plainly in two places and it remains the single largest unknown in the
project. Fixtures encode what we believe real forms look like; only a real form
can tell us where that belief is wrong.

**To close:** apply to one real Greenhouse, one real Lever and one real Ashby
posting. Capture each as an anonymised fixture **before** fixing anything
against it. Every failure becomes a fixture and a failing test first.

**Why it is first:** every other estimate in this file — how often the scorer
fires, whether stage 2 is worth building, whether a backend is needed at all —
is a guess until this happens.

---

## 2. There is no backend, so both model stages are unreachable

`WXT_BACKEND_ORIGIN` is set nowhere. There is no `.env`, and no service exists
at the other end of `backend/semantic.ts`. The wire format, the port, the Zod
schemas and the `connect-src` pin are all written and tested against fakes, but
in any build produced today stage 1 and stage 2 cannot execute.

This fails **closed** — a field stays refused, which is exactly today's
behaviour — so it is not a bug. It does mean the model path has never run
end to end against a real model, only against fakes.

**To close:** decide whether the backend is worth building at all. Gap #3 says
that decision should wait for gap #1.

---

## 3. Whether stage 2 (and the backend) earns its place is untested

The deterministic scorer settles 10 of 13 corpus cases for free. The corpus is
ours. If the real-form rate is similar, the model path is being built for a thin
tail, and the honest answer may be to not build the backend at all and let the
remaining fields stay refused.

**To close:** instrument the scorer during gap #1 and count. Measure before
building, per §9 step 4 of `SEMANTIC_FILL_BRIEF.md`.

**Related, already decided:** there is deliberately **no similarity/Jaccard
tier** in the scorer. `semantic/option-match.ts` argues that any threshold
admitting the good cases also admits `Virginia` → `West Virginia` and `Newark` →
`New York`. That is a considered refusal, not a missing feature; do not "fix" it
without reading the header first.

---

## 4. `tests/semantic/apply.test.ts` is red and untracked

A 273-line test exists for `src/packages/semantic/apply.ts`, which does not
exist. This is a correct mid-TDD state — failing test written, module not — but
it is untracked, so it is invisible to `git status` consumers and will fail
`npm run check` for anyone who picks it up.

The test's own header states the reason the module should exist: the four-call
sequencing currently lives in `background.ts` where nothing can test it, and the
fixture test carries a second copy. Two implementations of "what order do these
run in" is one more than can be right.

**To close:** write `semantic/apply.ts`, make the test pass, commit both. Small
and well specified by the test that already exists.

---

## 5. The cache's three narrower scopes have no writer

`semantic/cache.ts` looks up across `exact_field → company → ats → global` but
only ever **writes** `global`, because stage 1 deliberately sends no company,
ATS or URL. The three narrower paths are therefore dead until something writes
them.

This is documented in the file header as a deliberate choice — the lookup shape
avoids a later migration, and `global` is the scope that makes the second
application free. Recorded here so it is a known open end rather than a
discovery.

**To close:** either give a narrower scope a writer, or delete the paths and the
migration risk with them. Not urgent.

---

## 6. Phase 8 is half-built

The repeated-question cache works. **Approving and editing free-text answers
does not exist.** `IMPLEMENTATION_STATUS.md` marks Phase 8 "partly done" for
this reason.

This is the seam the free-response work in gap #7 plugs into.

---

## 7. The free-response / voice subsystem is designed only to Section 1

Design decided in conversation on 2026-08-31, **not yet written to a spec** and
not implemented. What was settled:

- **Capture on fill, plus import.** Praedos captures a free-response answer when
  it is active on the page, plus a one-time import of past cover letters. Stays
  on `activeTab` — no permission change, no always-on content script.
- **Reuse verbatim, draft the rest.** Portable questions ("describe a hard
  problem you solved") refill with the user's exact past words — no model
  involved. Company-specific questions ("why us") produce a draft.
- **Compose only from the user's own material.** The drafting step may assemble
  and adapt what the user has actually written; anything it cannot ground in a
  stored specific comes back as a *gap to fill*, never as invented prose.
- A verbatim reuse may autofill. A composed draft **never** autofills — enforced
  by separate types, not by a threshold.

**Still undesigned:** data flow, cold start (what happens on application #1 with
an empty corpus), the portable-vs-company-specific classifier, storage shape,
and testing. Section 1 (module boundaries) was presented and is awaiting
approval.

**Why it matters:** this is the differentiator. Simplify and Jobright produce
generic AI prose; the anti-slop mechanism here is that output is provably made
of the user's own sentences and specifics.

---

## 8. Surfaces that are entirely unimplemented

From the competitive research on 2026-08-31 — no open-source tool examined
implements any of these either, which is why they are the opportunity as well as
the gap:

| Surface | State |
|---|---|
| Workday multi-step wizard | Not started (Phase 7). Per-step validation gating, and dropdown option order **varies per question**, so positional clicking can select "No" on work authorization |
| Account creation | Not started. Workday requires signup before applying |
| Shadow DOM traversal | Not implemented anywhere in the codebase |
| Cross-origin iframes | Not implemented. Some enterprise ATS embeds use them |
| iCIMS, Taleo, SmartRecruiters, SuccessFactors | No detector, no fixtures, no adapters |
| Anti-bot / CAPTCHA | Not addressed at all — see gap #9 |

Two findings worth carrying into Phase 7 when it starts:

- **Lever fires hCaptcha on programmatic checkbox/radio clicks.** A working
  approach elsewhere is to fill text, textarea and native selects only, and list
  the skipped controls for the user to tick.
- **SuccessFactors-family portals can silently diverge** — an uploaded resume is
  parsed once and not reliably re-parsed, so the stored profile drifts from the
  file with no error shown. If a portal offers a "review your profile" step,
  surface it as a required check.

---

## 9. Anti-bot exposure has never been assessed

Synthetic mouse events, native-setter writes and programmatic `DataTransfer`
file injection are precisely the fingerprint bot-detection systems look for.
No source consulted addressed CAPTCHA, Cloudflare/PerimeterX, request pacing or
ATS terms-of-service exposure.

Recorded as an unexamined risk sitting under the whole product, not as a task.
It should be decided deliberately rather than discovered in production.

---

## 10. Process gap: parallel agents duplicated work

On 2026-08-31 a subagent was dispatched to implement steps 1–4 of
`SEMANTIC_FILL_BRIEF.md` in a worktree while the full seven-step implementation
was already landing on `main`. The branch conflicted add/add on every file and
was discarded. Nothing was lost but the time.

**To avoid:** check `git log main` immediately before dispatching an agent
against a written brief, and again before merging its branch.

---

## Not gaps — decided, do not re-open

- **No similarity tier in the option scorer.** See gap #3.
- **The concept cache is a separate store**, not an extension of
  `LearnedMappingStore`. `userConfirmed` carries the user's authority and a
  model's guess must not inherit it.
- **A semantic mapping cannot autofill.** `sourceScores.semantic` (0.80) sits
  below `autofillThreshold` (0.95) by design. On this route the confidence cap,
  **not** `requiresVerifiedValue`, is what stops a work-authorization question
  from autofilling — a mutation check confirmed it. If either number moves, run
  `tests/semantic/safety.test.ts` and read what it says first.
