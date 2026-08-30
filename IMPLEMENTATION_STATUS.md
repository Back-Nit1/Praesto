# Implementation Status

Required by `prompt.md` section 0.13. Updated as work lands.

**Last updated:** 2026-08-30
**Tests:** 206 passing · **Typecheck:** clean · **Build:** 503 kB

---

## Where the project stands

| Phase | Status |
|---|---|
| 0 — Repository foundation | **Done** |
| 1 — Canonical applicant profile | **Done** |
| 2 — Resume parsing onboarding | Not started (deliberately deferred — see below) |
| 3 — Generic semantic form engine | **Done**, including the mapping playground |
| 4 — Generic fill engine | **Mostly done** — adapters, verification, side-panel review and correction all work; audit persistence outstanding |
| 5 — Learned corrections | **Done** |
| 6 — Greenhouse + Lever | Detector done; no ATS-specific adapters yet (none needed so far) |
| 7 — Workday | Not started |
| 8 — Question / answer memory | Not started |

Resume parsing is deferred on the spec's own instruction (section 30): *"do not
let it block testing the core application engine."* A manually entered profile
already exercises detection → mapping → resolution → filling → review, which is
the part of the product that has to be right.

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
- [ ] Audit records persisted to IndexedDB — the store and schema exist;
      `REPORT_FILL_RESULTS` feeds the learning counters but is not archived

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

## Current limitations

Stated plainly, because the product's whole claim is that it does not overstate
what it knows.

1. **No resume parsing.** The profile is entered by hand or imported as JSON.
2. **Corrections apply to scalar profile fields only.** The side panel's picker
   lists the ~30 scalar paths. Correcting a field to a specific education or
   employment entry (`education[0].gpa`) needs an entry picker the UI does not
   have yet.
3. **Custom dropdowns are not driven.** A `[role="combobox"]` is detected and
   described, but no adapter can open one and pick an option, so Workday-style
   controls are reported and left alone.
4. **One profile.** The schema carries an `id` and a `label` for multiple
   profiles and resume variants; the UI exposes one.
5. **Repeated entities are not editable in the UI.** Education, employment and
   projects are fully modelled, mappable and resolvable, but the editor has no
   screens for them yet, so they can only be populated via JSON import.
6. **No iframe support.** Fields inside an iframe are not scanned. The
   descriptor already carries `inIframe` and the architecture keeps per-frame
   scanning possible (spec section 17), but the coordinator is not built.
7. **Non-NANP phone numbers get no national format.** International numbers
   store a correct E.164 form and digit string; a locale-idiomatic national
   format would need libphonenumber, whose ~145 kB is a real cost on the
   low-memory machines this extension targets. The resolver refuses the formats
   it cannot produce rather than emitting a wrong one.
8. **Dynamic rescans are detected but not acted on.** The `MutationObserver`
   fires and logs; wiring it to an incremental rescan is Phase 4 cleanup.
9. **English-only aliases.**

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

**Test against real Greenhouse and Lever applications.** Every layer the spec
asks for before this point now exists and is covered by tests, but every test so
far runs against markup *we* wrote. The fixtures encode what we believe real
forms look like; only a real form can tell us where that belief is wrong.

The method matters more than the finding: each failure becomes a fixture and a
failing test before anything is changed, and the fix goes into the generic
engine unless it genuinely cannot (spec section 18). Expect most gaps to be
missing aliases — cheap, precise fixes — rather than anything structural.

After that, in order:
1. **Persist audit records to IndexedDB.** They are the input to every metric in
   spec section 26, and without them "incorrect-fill rate" — the metric the
   spec calls most important — cannot be measured at all.
2. **Wire the MutationObserver to an incremental rescan**, so conditionally
   revealed questions are picked up without a manual rescan.
3. **Resume ingestion (Phase 2).**
4. **An ARIA combobox adapter**, which is the prerequisite for Workday and
   already the most common reason a detected field is left alone.

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
npm run compile   # tsc --noEmit, strict
npm test          # 188 tests
npm run build     # loads unpacked from .output/chrome-mv3
```
