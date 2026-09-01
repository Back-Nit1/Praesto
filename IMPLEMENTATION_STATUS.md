# Implementation Status

Required by `prompt.md` section 0.13. Updated as work lands.

**Last updated:** 2026-09-01
**Tests:** 732 passing · **Typecheck:** clean · **Build:** clean (`dist/chrome-mv3`)

---

## Where the project stands

| Phase | Status |
|---|---|
| 0 — Repository foundation | **Done** |
| 1 — Canonical applicant profile | **Done** |
| 2 — Resume parsing onboarding | **Done** |
| 3 — Generic semantic form engine | **Done**, including the mapping playground |
| 4 — Generic fill engine | **Done** — adapters, verification, side-panel review and correction, audit persistence and history |
| 5 — Learned corrections | **Done** |
| 6 — Greenhouse + Lever | Detector done; semantic fallback done; no ATS-specific adapters yet (none needed so far). **Not yet run against a real application** |
| 7 — Workday | Not started |
| 8 — Question / answer memory | **Partly done** — the repeated-question cache exists and works; approving and editing free-text answers does not |

Resume parsing was built last, on the spec's own sequencing instruction
(section 30): *"do not let it block testing the core application engine."* The
core engine was proven against a manually entered profile first.

---

## Phase 0 — Repository foundation

**Definition of done, item by item:**

- [x] Extension builds and loads unpacked in Chrome
- [x] TypeScript strict mode (plus `noUncheckedIndexedAccess` and
      `exactOptionalPropertyTypes`)
- [x] React side panel and options page
- [x] Shared modules with enforced boundaries
- [x] Vitest configured; `npm test` runs everything
- [x] Typed extension messaging with Zod validation at the boundary
- [x] Local storage repositories
- [x] This file

**Deviation:** Playwright is not installed. The end-to-end behaviour the spec
wanted it for — scanning and filling real HTML — is covered by
`tests/form-engine/fixtures.test.ts`, which runs the full pipeline over the
`fixtures/forms/` files in jsdom, in ~100 ms and with no browser download.
Playwright becomes worth its weight when we start regression-testing live ATS
pages (Phase 6), and the fixtures will carry over unchanged.

---

## Phase 1 — Canonical applicant profile

- [x] Zod schema with `ProfileValue<T>` provenance on every value
- [x] Repository with validation on read *and* write
- [x] Versioned storage plus a migration runner
- [x] Profile editor UI with the four-state display from spec section 9
- [x] Raw *and* normalized date/phone values
- [x] JSON export/import
- [x] Verified values survive a merge

**The invariant, stated once:** `mergeCandidates` never overwrites a
user-verified value, and never silently replaces an unverified value that
disagrees — it reports a conflict for the user to settle. Tested in
`tests/profile/repository.test.ts`.

---

## Phase 3 — Generic semantic form engine

- [x] Field scanner (chunked, budget-aware, DOM-isolated)
- [x] Label / accessible-name extraction
- [x] Descriptor builder
- [x] Semantic fingerprints at four scopes
- [x] Alias registry (~200 phrasings)
- [x] Mapping cascade
- [x] Centralized confidence policy
- [x] Value resolver
- [x] Mapping playground (options page → *Mapping playground*)

**Deviation from spec section 12.1 — score-and-select instead of
first-match-wins.** The spec lists the cascade as an ordered sequence that
returns on the first hit. We run every strategy, collect candidates, then
select. The spec's ordering is preserved exactly, as the score ranking in the
confidence policy. The change buys three things a short-circuit cascade cannot
give: agreement between independent signals becomes measurable evidence,
disagreement becomes visible and is resolved by an explicit precedence rule
rather than by whichever strategy ran first, and competing interpretations are
reported as `alternatives` instead of being discarded. Rationale is in the file
header of `src/packages/form-engine/mapper/mapper.ts`.

---

## Phase 4 — Generic fill engine

- [x] Native adapters: text/textarea, select, checkbox, radio
- [x] Native property setter + bubbling event strategy
- [x] Post-fill verification by read-back
- [x] Side-panel audit list
- [x] High/medium/low confidence behaviour
- [x] Debounced `MutationObserver`
- [x] User correction UI — every row in the audit list has a **Change** control
- [x] Audit records persisted to IndexedDB
- [x] Durable application history, with recovery of the current scan

---

## Application history and recovery

Two different problems, deliberately solved with two different lifetimes.

**Recovery — `chrome.storage.session`, per tab.** The side panel's scan lived in
React state and nowhere else, so closing the panel destroyed the record of which
fields had failed. A user who filled eighteen questions, closed the panel to
read the job description and came back had to re-read the whole form to find the
two that had not landed — the exact work this product exists to remove. The
panel now restores its last scan for the same tab *and* the same address, and
says on screen that what it is showing is a record rather than a live reading.

**History — IndexedDB, 200 runs / 2000 rows / 90 days.** One `FillAuditRecord`
per scanned field (spec section 24), grouped into runs for the options page's
*History* tab.

**How a fill result finds the scan that produced it.** Spec section 24 wants the
detected label, the mapping confidence and the cascade stage in every record.
Only the worker knows those, for the few milliseconds inside `resolveFields` —
and the fill report arrives in a later message, by which time MV3 has often
evicted and restarted the worker. So the scan's metadata is stashed in session
storage at resolve time and joined at report time (`src/packages/audit/`). The
join key is tab + canonical URL, for the reason the side panel already
documents: every posting on a careers site shares a hostname.

**Rows are written for every scanned field, not only the filled ones.** A
history that lists thirteen successes and says nothing about the five questions
we did not understand flatters us; the five are what the user typed by hand and
what a correction would fix.

**The applicant's answer is never recorded.** `FillAuditRecord` has no field
that could hold one, and `tests/audit/join.test.ts` asserts the key set from
outside the type system. The one exception in this feature is the panel's
session snapshot, which does hold resolved values so a suggestion can be filled
after a restore without rescanning — session-area, never on disk, gone when the
browser closes. Written up in `Security.md` §9.

**Retention cuts on a run boundary and never removes the newest run.** Half an
application in the history is worse than none of it, and a ceiling that hid the
fill you just performed would read as the feature being broken.

**History never fails a fill.** Every write on that path is logged and
swallowed. Reporting a fill that worked as failed because a history write failed
would be a lie in the one direction this product must not tell one.

---

## Development metrics (spec section 26)

**Four of the seven are computed; the other three are refused rather than
estimated.** `src/packages/audit/metrics.ts` is pure — runs in, metrics out — and
is surfaced on the options page behind a developer toggle that defaults off.

**The blocker was a boolean that recorded two opposite events identically.**
`userCorrected: boolean` was set both when we filled a field wrongly and the
user fixed it, and when we correctly refused a field and the user taught us what
it meant. The first is the failure section 26 names as the most important metric
to track; the second is the learning loop working. It is now a `FieldOutcome`
with seven states, and the incorrect-fill numerator admits exactly two of them —
asserted by a test from outside the module, so adding an eighth outcome fails a
test rather than silently changing what the metric means.

**Silence is not evidence of correctness.** Most fields are never corrected, so
`corrections ÷ fills` is a permanent lower bound. Every rate is an `ObservedRate`
carrying its own denominator and the count of rows that said nothing, and there
is no way to get a bare percentage out of it. Below twenty reviewed rows the
screen prints "not enough evidence" and no figure at all; above it, the `≥`
says the true rate cannot be lower and may be higher.

**One correction is one piece of evidence.** A correction still marks every
recent row sharing the fingerprint — the mapping was wrong every time it was
used — but only the newest carries the verdict. Without that, the incorrect-fill
rate would scale with how often the user applies to the same company.

**Accepting a suggestion is the only positive signal in the system.** It is set
by the side panel at the point of the click and carried through the page in the
fill report; everything else the audit trail holds is a failure or a silence.

**Rows written before the split read as `corrected_legacy`** and are counted in
no numerator and excluded from every denominator. The boolean did not record
which outcome it meant, and guessing would fabricate exactly the data this work
exists to make trustworthy. They live in IndexedDB, which `runMigrations` does
not walk, so they are normalised on read rather than rewritten.

**Not computed, and why:**

- *Field-mapping precision* and *verified-fill precision* need ground truth
  about what each field **should** have mapped to. User history has never
  contained that and never will. They belong to the fixture corpus, computed in
  the test run against expected-mapping tables.
- *Repeated-question reuse rate* is computed but is an **upper bound**:
  `mappingSource` records `'semantic'` for a cache hit and for a fresh model
  call alike, so a first-ever question answered by the model counts as reuse.
  Separating them needs a cache-hit signal that does not exist.

---

## The settings screen, and required fields

Two surfaces added on 2026-09-01, both of which existed as data the UI never
read.

**Required-but-blank fields are named** (spec §33). `required` was captured by
the scanner and typed on the descriptor from the beginning, and nothing read it
— so a required question we did not understand sat in "Left blank" beside every
optional one. It now has its own group above the review list, holding the three
situations whose next action is the same: not understood, offered and not
accepted, or attempted and refused by the page. A field the page had already
answered is not listed. `prefilled` crosses the message boundary as a boolean,
never as the value.

**Settings** holds what the panel deliberately does not: today's model-call
spend and the last twenty scans' costs, the count of remembered questions with a
way to forget them, and the developer toggle. It is read between applications,
not during one — the same reasoning that keeps mapping metadata out of the
panel. `SemanticConceptCache.clear()` had existed since the cache was written
with nothing calling it, so a wrong cached concept could previously only be
escaped by wiping all extension data.

---

## Phase 5 — Learned corrections

- [x] Learned-mapping schema and repository
- [x] All four scopes (global / ats / company / exact_field), narrowest wins
- [x] Correction capture from the side panel
- [x] Successful-use and correction counters
- [x] Confidence adjusted by history
- [x] Rules inspectable and deletable from settings
- [x] Bad rules cannot trap the system

**Definition of done, verified by test:**
`tests/learning/mapping-memory.test.ts` reproduces the demo target from spec
section 31 steps 9–12 end to end — an unfamiliar question ("Preferred hub") maps
to nothing, the user corrects it once on a Greenhouse form, and the same
question on a Lever form with entirely different markup then maps correctly at
autofill confidence.

**Three layered escapes from a bad rule** (spec section 19 requires that they
exist; each covers a case the others do not):
1. correction counts feed an *uncapped* confidence penalty, so a rule that is
   repeatedly wrong falls below the suggestion floor on its own;
2. past three corrections a rule is *retired* — kept in storage and shown in
   settings, but never returned by a lookup, so the user can see the system
   noticed rather than assuming it forgot;
3. the user can delete any rule, or all of them, from settings.

**"This field means nothing" is a first-class correction.** A user-confirmed
rule with an empty path short-circuits the mapping cascade rather than competing
in it. Competing would not be enough: a field labelled "Email" matches the alias
registry at 0.97, so a merely-equal-weight rule would lose and the extension
would keep filling the field the user just told it to stop touching.

---

## Phase 6 / 8 — Semantic fallback for refused fields

The deterministic pipeline leaves a field blank whenever the mapper cannot name
the question or the resolver cannot match our answer to an offered option. That
is still the default and still the behaviour when anything goes wrong. This adds
one stage that runs **only on those refusals**, and feeds its results back
through the **existing** `decideFill`, so the sensitive-field gate applies to a
model-derived mapping exactly as it applies to an alias match.

- [x] Refusal queue (`@semantic/queue`) — pure, synchronous, no I/O
- [x] Persistent concept cache, so a distinct question costs at most one call ever
- [x] Deterministic option scorer, which settles most option failures for free
- [x] Stage 1: batched question → `ProfilePath`, no profile data sent
- [x] Stage 2: one value + one option list, only when the scorer cannot decide
- [x] Wire schemas, Zod-validated, page text carried as `untrusted`
- [x] `connect-src` pinned to the compiled-in backend origin
- [x] Wired into the scan pipeline, and the panel says when AI help ran out
- [ ] **Run against a real Greenhouse, Lever or Ashby application**
- [ ] **The two backend endpoints exist**

**The order is the design**, and each step is cheaper than the next:

    cache    free, private, instant. The second application makes zero calls.
    scorer   free, deterministic. 10 of 13 corpus cases die here.
    model    last. Two stages, minimal data, and its answer is a SUGGESTION.

**A semantic mapping can never autofill.** `sourceScores.semantic` (0.80) sits
below `autofillThreshold` (0.95), so a novel question surfaces as something the
user reads. It is promoted the way every mapping is promoted: the user accepts
it, the existing correction path writes a `LearnedMapping`, and the *next*
encounter matches at 0.96 with the user's own authority behind it. There is no
path by which the number rises on its own.

**Worth knowing, because it is not the obvious answer:** on this route the
confidence cap — not `requiresVerifiedValue` — is what keeps a work
authorization question from autofilling. The sensitive-path gate deliberately
permits a value the user typed themselves, which is the whole point of storing
one. A mutation check confirmed this: raising `sourceScores.semantic` to 0.99
turns all four sensitive-field tests into autofills.
`tests/semantic/safety.test.ts` says so in as many words.

**Two narrowings stand between a model reply and a filled field**, and both are
tested by feeding in answers that fail them:

1. a returned path must be one *we* defined (`isProfilePath`). A model naming
   `contact.bloodType` is refused, and the refusal is cached so it is not
   re-asked;
2. a returned option must be one the *form* offers, matched in our code against
   the real list. Never chosen by index — an off-by-one index names a real,
   valid, wrong option that nothing downstream could detect.

**The cache is a second store, not an extension of `LearnedMappingStore`.** A
learned mapping carries the user's authority and scores at 0.96; a model's guess
must not inherit that by being stored where the mapper reads. It would also
compete for that store's 1000-rule cap and start evicting real user corrections.
`semantic/cache.ts` records the full argument.

**The pass is one function, not four calls at the call site.** It lived in
`background.ts`, where nothing could test it, and the fixture test had its own
copy of the same sequence — two implementations of an ordering is one more than
the number that can be right, and the copy in the test would have gone on
passing while the shipping one drifted. `applySemanticFallback` is now called by
both.

It returns **updates** rather than mutating the caller's actions, which is the
central safety property in type form: the function has no way to express "leave
that field worse than you found it". A failure of any kind is exactly today's
behaviour, without needing a test per failure path.

**A failure is reported, not swallowed.** A user whose fields quietly stop
improving cannot tell "we are out of AI answers until tomorrow" from "this form
just did not match", and only the first is something they can act on. The wire
carries a closed vocabulary — `rate_limited` / `offline` / `unavailable` — never
the `AppErrorCode`, so there is no path by which `BACKEND_REJECTED` reaches
somebody's screen mid-application. `SEMANTIC_FAILURE_TEXT` sits next to the wire
type, so adding a kind without a sentence is a compile error.

**A null answer is cached like any other.** "No path fits this question" is the
correct answer to "How did you hear about us?", and to most of the questions a
user actually meets. Not remembering it would mean paying for it on every
application forever.

---

## Current limitations

Stated plainly, because the product's whole claim is that it does not overstate
what it knows.

1. **Resume parsing is single-column, text-native PDF only** (spec 8.1). A
   two-column layout produces interleaved lines; the extractors pick out what
   they recognise rather than assuming a clean document, so the result is
   partial rather than wrong. DOCX and OCR are not implemented — a scanned PDF
   is detected and reported as such, and the file is still stored for
   attachment.
2. **One profile.** The schema carries an `id` and a `label` for multiple
   profiles and resume variants; the UI exposes one.
3. **Which entry an unqualified question means is a heuristic.** "School" with
   no section heading resolves to the most recent education, "Employer" to the
   current job (`profile/selectors.ts`). A form asking about a *second* school
   without labelling it as such will be answered from the first, and the user
   has to correct it. A form that labels its blocks - which most do - is
   resolved correctly by the section heading.
4. **A combobox is driven blind.** The adapter opens the control, waits for the
   list and clicks a unique match. It cannot read options that are fetched from
   a server only after several keystrokes, and it refuses rather than guessing
   when more than one option matches.
5. **Non-NANP phone numbers get no national format.** International numbers
   store a correct E.164 form and digit string; a locale-idiomatic national
   format would need libphonenumber, whose ~145 kB is a real cost on the
   low-memory machines this extension targets. The resolver refuses the formats
   it cannot produce rather than emitting a wrong one.
6. **A revealed question needs a click.** The `MutationObserver` tells the side
   panel the form changed and the panel offers a rescan; it never rescans or
   fills on its own. That is deliberate - a question the form reveals in
   response to an answer must not be answered without the user seeing it - but
   it does mean an extra click on a conditional form.
7. **English-only aliases.**
8. **A history row whose scan has expired says less.** If the stash is gone —
   more than 30 minutes between scanning and filling, or a browser restart in
   between — the row is still written, but with no label, no confidence and
   `mappingSource: 'none'`, because that is what is honestly known by then. It
   also carries `ats: 'unknown'`, since the scanner's fill report hardcodes that
   in its page context; fixing it is a change to the content script's message.
9. **The scan-to-history join has no end-to-end test.** Every piece of it is
   tested in isolation — the join, retention, the repository, the stash — but
   the worker itself has no test harness in this repo, so the wiring between
   them is verified by hand. That is the largest untested seam in this feature.
10. **The end-to-end tests run against our own fixtures.** They use a real
   browser, the real build and the real message pipeline, so they catch a
   rejected manifest, an unregistered worker or a fill that never lands - but
   the pages are ours. An anonymised capture of a real Greenhouse, Lever, Ashby
   and Workday application is the next thing worth adding, and every real-world
   failure should become a saved fixture and a failing test before it is fixed.
11. **The semantic fallback has never run against a real application, or a real
   backend.** The fixtures in `fixtures/forms/*-semantic.html` are written from
   each ATS's published naming conventions, not captured from real forms, and
   every test runs against a fake port. So the subsystem is proven against the
   *shape* of Greenhouse, Lever and Ashby markup and against its own contracts.
   It is not proven against Greenhouse. The backend endpoints
   (`/v1/semantic/concepts`, `/v1/semantic/option`) do not exist yet.

12. **The option scorer is deliberately weak in the middle.** It settles exact
   matches, case and punctuation differences, reordered labels
   ("Computer Engineering" / "Engineering, Computer") and guarded containment.
   It has NO general similarity tier, because any Jaccard or edit-distance
   threshold that admits the good cases also admits "Virginia" against "West
   Virginia" — and the failure that produces is not a blank field but a
   confident wrong one. The cost is real and is paid in model calls: a
   single-token value against a longer option ("Rutgers" against "Rutgers
   University - Newark") always escalates, and so does every numeric value
   against a range dropdown. On the 13-case corpus in
   `tests/semantic/option-match.test.ts`, 10 are settled locally.

13. **Cache eviction is oldest-first, not least-recently-used.** LRU needs a
   write on every read, and the cache is read on the hot path of every scan —
   which would turn the free cache hit into a storage write and defeat its
   purpose. At the 500-entry cap the difference is theoretical, but a user who
   met 500 novel questions would start paying again for their oldest ones.

14. **The panel still says nothing about model calls on a successful scan**, and
   that part is deliberate — a panel that narrates its own internals every scan
   is one the user stops reading. "How much of my daily budget did this form
   cost" is now answered on the settings screen instead, from a log of the last
   twenty scans that holds a time and a count and nothing else. What no surface
   can say is WHICH questions a scan's calls answered.

15. **A cached concept is never re-examined.** If a model's answer for a
   question was wrong, the user corrects the field once and the existing
   learned-mapping path takes over at higher confidence — but the wrong cached
   concept stays until the cache is cleared. The settings screen now clears it,
   all of it: there is no way to forget ONE wrong reading, and the cache does
   not record which question a user later contradicted.

16. **The end-to-end suite grants host permission statically.** `activeTab` is
   granted by a click on the toolbar icon, which is browser chrome and cannot
   be automated, so the test copy of the build is given host access to the
   fixture server. The permission FLOW - a lapsed grant, a per-origin request -
   is therefore covered only by the panel's jsdom tests.

17. **Three of the seven metrics in spec section 26 are not computed.**
   Field-mapping precision and verified-fill precision need ground truth about
   what each field should have mapped to, which user history never contains;
   they belong to the fixture corpus. The repeated-question reuse rate IS
   computed but is an upper bound, because `mappingSource: 'semantic'` does not
   distinguish a cache hit from a fresh model call.

18. **Every rate is a lower bound, and always will be.** Most fields are never
   reviewed, so the incorrect-fill rate measures the mistakes the user
   *reported*, not the mistakes made. The metrics screen renders the unreviewed
   count beside every figure and refuses to print one at all below twenty
   reviewed rows, which is the honest handling — not a fix. The fix is a fixture
   corpus with known expected mappings.

19. **The incremental rescan sees additions only.** A revealed question is
   scanned where it appeared (spec §16), but a conditional block that
   DISAPPEARS leaves its rows in the panel until a full rescan, and a field that
   merely becomes required or enabled produces no mutation the observer acts on.
   Both are written up in `gaps.md` §11.

20. **A scan's cost is recorded, but nothing records what it bought.** The
   settings screen can say a scan spent three model calls; it cannot say which
   three questions they answered, because the log deliberately holds a time and
   a count. Answering that would mean joining it to history, which is a
   disclosure decision rather than a missing feature.

21. **No metric has ever been computed over real data.** The audit trail now
   carries the outcomes they need, but no application has been filled outside
   our own fixtures, so the numbers on that screen have only ever been produced
   by tests. This is the same gap as limitation 11, and the same capture closes
   both.

---

## Known bugs

None currently known.

Two were found and fixed during implementation, both worth recording because
each would have been near-invisible in production:

- **Native setter cache bound to the wrong element.** `setNativeValue` cached a
  setter bound to the first element it saw, keyed by prototype — so every fill
  after the first wrote into that first element. A single-field test would have
  passed. Caught by `tests/fill-engine/adapters.test.ts`.
- **Radio-group fingerprint computed too early.** A group's fingerprint was
  computed from the first radio, before its sibling options were merged, so the
  same question would fingerprint differently depending on how the scan
  proceeded — silently breaking learned mappings on every radio question. The
  scanner now recomputes group fingerprints after the merge.

---

## Next recommended task

**Test against real Greenhouse, Lever and Ashby applications.** This was the
next task before the semantic fallback landed and it is still the next task —
more so now, because there is a second layer whose fixtures are also markup
*we* wrote. They encode what we believe real forms look like; only a real form
can tell us where that belief is wrong.

The method matters more than the finding: capture each real form as an
anonymised fixture **before** fixing anything against it, then a failing test,
then a fix in the generic engine unless it genuinely cannot go there (spec
section 18). Expect most gaps to be missing aliases — cheap, precise fixes —
rather than anything structural.

The outcome split landed before this capture deliberately. That capture is the
first time real corrections get generated, and a row written under the old
`userCorrected` boolean cannot be attributed to an outcome afterwards — it can
only be read as `corrected_legacy` and counted in nothing.

Two questions the fixtures cannot answer and a real form can:

- **How many refusals does the deterministic scorer actually settle?** The
  10-of-13 figure is measured against a corpus we invented. If the real number
  is much lower, the answer is a better scorer, not a bigger quota — every case
  it settles is free, private and instant.
- **Which questions does stage 1 get wrong?** A wrong concept is not a wrong
  fill (it arrives as a suggestion), but it is noise in the review list, and
  noise trains the user to click through without reading — which would destroy
  the value of the review step this whole product is built around.

After that, in order:
1. **Stand up the two backend endpoints.** `/v1/semantic/concepts` and
   `/v1/semantic/option` are specified by the schemas in `backend/schemas.ts`
   and do not exist. Until they do, the fallback degrades to today's behaviour
   on every field — which is correct, and is not the feature.
2. **Let the user see and clear the concept cache.** `SemanticConceptCache` has
   `clear()` and the settings screen does not call it, so a wrong cached
   concept currently has no escape short of clearing all extension data.
3. **Incremental rescan of a revealed subtree**, so a conditional question
   appears in the panel without a full rescan. The signal is wired; only the
   incremental path is missing.
4. **ATS-specific rules for Greenhouse, Lever and Workday**, added only where
   the generic engine genuinely cannot reach (spec section 18).

---

## Architectural decisions that deviate from the spec

Each of these is a deliberate choice, not an oversight.

**1. Single package with enforced module boundaries, not a monorepo.**
Spec section 5 suggests `apps/extension` plus `packages/*` workspaces. We use
one package with `src/packages/*` and `tsconfig` path aliases. The
architectural boundaries the spec actually cares about are preserved and
enforced by the import paths; npm workspaces would add install weight, a slower
cold build, and a second dependency graph to reason about, for no benefit at
this size. The spec explicitly permits this: *"If this structure would fight the
existing repository, preserve the existing layout but maintain the same
architectural boundaries."*

**2. Score-and-select mapping cascade.** Described above.

**3. No libphonenumber.** Described in limitations. `NormalizedPhone` is the
interface, so swapping the implementation in later changes no caller.

**4. Learned-mapping lookup is synchronous.** The mapper runs over every field
on a page. An async lookup per field would either serialise into hundreds of
awaits or force the entire cascade to be async, which would make the mapping
logic untestable without a promise-aware harness. The service worker loads the
rule set once per batch and hands the mapper an in-memory view.

**5. A runtime budget module the spec does not mention.**
`src/packages/shared/runtime-budget.ts` derives scan chunk size, field caps,
mutation debounce, PDF page concurrency and memory ceilings from
`navigator.deviceMemory` and `hardwareConcurrency`. The spec is silent on
performance, but this extension is meant to be installable by anyone — including
someone applying for internships on a 4 GB Chromebook — and unbounded DOM
scanning on the host page's main thread is how an extension gets uninstalled.
Every limit lives in one table so the performance posture is reviewable in a
diff. Crucially, the budget never influences a mapping or confidence decision:
a smaller budget means slower, never wrong.

**6. The page scanner is injected on demand, not declared as a content
script.** The spec does not say how the content script should be registered.
A declared `<all_urls>` content script - and a runtime-registered one, which
needs the same grant - makes Chrome request host access at install time and
warn that the extension can read and change data on every website. Instead the
scanner is built as a standalone script and injected by
`chrome.scripting.executeScript` when the user clicks Scan, which runs under
`activeTab`: one tab, after a click, until they navigate away. The built
manifest therefore declares no host permissions and no content scripts. The
tradeoff is that nothing observes a page before the user asks, which is the
behaviour we wanted regardless.

**7. Scanner returns element references separately from the serializable
result.** The spec does not specify how a fill instruction finds its element
again. Stamping `data-aa-id` on the page was rejected: it mutates a page we do
not own, is visible to the site's own scripts, and can be stripped. Instead
`scanPage` returns `{ result, elements }`, where `elements` is a Map that cannot
be serialized and therefore cannot cross the message boundary. The worker can
name a field; it cannot address a DOM node.

---

## Verification

```
npm run compile    # tsc --noEmit, strict
npm test           # 732 tests
npm run build      # -> dist/chrome-mv3, loads unpacked in Chrome
npm run fixtures   # practice forms at http://localhost:5174
```
