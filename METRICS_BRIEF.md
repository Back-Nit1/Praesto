# Implementation brief — honest development metrics (spec §26)

**Status:** approved design.
**For:** the agent implementing this. Read this file, then `engineering.md`,
then `prompt.md` sections 24 and 26, then `src/packages/audit/types.ts` in full
before writing code.

---

## 0. What you are building, in one paragraph

Spec §26 requires seven development metrics and names incorrect-fill rate as the
most important one. None exist. The audit trail almost supports them: every
scanned field already writes a `FillAuditRecord` carrying `decidedAction`,
`fillAttempted` and `fillVerified`. The blocker is `userCorrected: boolean`
(`audit/types.ts:68`), which conflates two opposite events — "we filled a field
wrongly and the user fixed it" and "we correctly refused a field and the user
taught us what it means". The first is the failure the product exists to avoid;
the second is the learning loop working exactly as designed. You are replacing
that flag with an outcome the numerator can trust, fixing a double-count in the
way corrections are attributed, and adding one pure metrics module behind a
developer toggle.

You are not adding a user-facing dashboard. §26 is metrics FOR DEVELOPMENT.

---

## 1. Decisions already made

Do not relitigate these. If you believe one is wrong, stop and say so rather
than quietly implementing something else.

| # | Decision | Rationale |
|---|---|---|
| 1 | **Silence is not evidence of correctness.** An unreviewed row counts toward no numerator and no denominator. | Most fields are never corrected. corrections ÷ fills is a lower bound forever, and rendering it as a point estimate would make it the one lying number in a product whose entire claim is that it does not overstate what it knows. |
| 2 | **Every rate carries its own denominator and its unreviewed count.** No bare percentage is ever returned or rendered. | Same reason. Enforce it in the type, not in the render. |
| 3 | **A correction is attributed to one run.** Older rows sharing the fingerprint keep showing as corrected in history, but are excluded from metrics entirely. | See §4.2. Otherwise the incorrect-fill rate scales with how often the user applies to the same company. |
| 4 | **Mapping precision is computed against fixtures, not history.** | User history contains no ground truth. Deriving precision from it is the same conflation in a new costume. Out of scope here; note it and move on. |
| 5 | **Legacy rows are excluded, never reinterpreted.** | Guessing which outcome an old boolean meant would fabricate the exact data this work exists to make trustworthy. |

---

## 2. The seams that already exist

- `FillAuditRecord.decidedAction` (`audit/types.ts:64`) — `'fill' | 'suggest' |
  'skip' | 'attach_resume'`. This is what the policy decided BEFORE any fill.
  Combined with the user's verdict it fully determines the outcome; you do not
  need a new message to classify.
- `FillAuditRecord.fillVerified` (`audit/types.ts:67`) — true only on read-back.
- `AuditRepository.markCorrected` (`audit/repository.ts:113`) — already loads
  the rows it marks, so it can derive per-row outcomes at mark time.
- `background.ts:360` `RECORD_CORRECTION` — the only caller, at
  `background.ts:399`. It already knows `request.profilePath === null`, which is
  the "this field means nothing" correction.
- `groupIntoRuns` / `countRun` (`audit/types.ts`, bottom) — pure, testable, and
  the model for the module you are adding.
- `MappingSource` (`form-engine/mapper/types.ts`) — `'memory'` and `'semantic'`
  are the reuse signals. Note its `'semantic'` comment still says "not wired
  yet"; it is wired. Fix that comment while you are there.

---

## 3. The type

Replace `userCorrected: boolean` with:

```ts
/**
 * What the user's action said about this row's decision.
 *
 * The boolean this replaces could not tell a wrong fill apart from a user
 * teaching us a field we had correctly refused. Those are opposite signals:
 * the first is a failure, the second is the learning loop working.
 */
export type FieldOutcome =
  | 'unreviewed'                  // default. Nobody said anything. NOT "correct".
  | 'accepted_suggestion'         // the only positive evidence in the system
  | 'corrected_wrong_fill'        // we wrote a value; user changed the mapping
  | 'corrected_wrong_suggestion'  // we offered; user changed it before accepting
  | 'assigned_unmapped'           // we refused; user taught us
  | 'rejected_to_none'            // we touched a field that should be left alone
  | 'corrected_legacy';           // pre-migration boolean. Counted in nothing.
```

Field: `outcome: FieldOutcome`, plus `supersededByLaterCorrection?: boolean`
(see §4.2).

Derivation, as a pure exported function so it is testable without a database:

```text
decidedAction   profilePath   -> outcome
'fill'          changed       -> 'corrected_wrong_fill'
'fill'          null          -> 'rejected_to_none'
'suggest'       changed       -> 'corrected_wrong_suggestion'
'suggest'       null          -> 'rejected_to_none'
'skip'          any           -> 'assigned_unmapped'
'attach_resume' any           -> 'rejected_to_none' when null, else wrong_fill
```

Numerator for incorrect-fill rate is `corrected_wrong_fill` +
`rejected_to_none`, and nothing else. `assigned_unmapped` lowers the
unknown-field rate — the opposite direction. That is the whole point of this
work; put it in a comment next to the numerator.

---

## 4. Wiring

### 4.1 One signal is genuinely missing: acceptance

Accepting a suggestion currently produces another fill report indistinguishable
from an automatic fill. It is the only cheap positive evidence available. Add
`userInitiated: z.boolean().optional()` to the per-result object in
`reportFillResultsRequestSchema` (`shared/messages.ts:174`, the object at
`:180–190`); the side panel sets it when the user accepts a suggestion, and the
join maps `true` on a `'suggest'` row to `'accepted_suggestion'`.

Optional, not required, so an older content script keeps working — an absent
flag means "we do not know", which is `'unreviewed'`. Never `'accepted'`.

### 4.2 Fix the double count before it exists

`markCorrected(fingerprint, limit = 500)` marks EVERY recent row sharing the
fingerprint. That is right for history — the mapping was wrong every time it was
used — and wrong for metrics, because one correction would inflate the numerator
once per run.

Keep the history behaviour. Attribute the derived outcome to the most recent
matching row; set `supersededByLaterCorrection: true` on the others and give
them the same outcome for display. The metrics module skips every superseded row
in both numerator and denominator.

Rename the method to `recordOutcome` while you are in there; it no longer sets a
flag, it records a verdict.

### 4.3 Writers

`audit/join.ts:79` and `:127` write `userCorrected: false`; both become
`outcome: 'unreviewed'`. `countRun` (`audit/types.ts`) counts `corrected` from
the boolean; it now counts any outcome other than `'unreviewed'`. The history
legend (`options/History.tsx:166–169`) and the per-field line at `:239` keep
saying "corrected" — the user-facing words do not change.

---

## 5. The metrics module

New file `src/packages/audit/metrics.ts`. Pure:
`computeMetrics(runs: readonly ApplicationRun[]): DevelopmentMetrics`. No
storage, no DOM, no clock. Modelled on `groupIntoRuns`.

```ts
/** A rate that cannot be read as more certain than it is. */
export interface ObservedRate {
  numerator: number;
  /** Rows that produced evidence either way. The denominator. */
  reviewed: number;
  /** Rows that produced none. Rendered beside the rate, never hidden. */
  unreviewed: number;
}
```

Return `ObservedRate` for: incorrect-fill rate, user-correction rate,
unknown-field rate, repeated-question reuse rate (`mappingSource` of `'memory'`
or `'semantic'` over all mapped rows). Fill-execution success rate
(`fillVerified ÷ fillAttempted`) is fully observed and may be a plain ratio —
say so in a comment, because it is the exception.

Rendering rule, enforced in the component: below a `reviewed` floor (start at
20, one constant, commented), render "not enough evidence" and NO number.
Above it, render `≥ 2.1% (2 of 47 reviewed · 310 unreviewed)`. The `≥` is not
decoration: it says the true rate cannot be lower, and may be higher.

Surface it on the options page behind the developer/debug toggle that
`prompt.md` §22 asks for and that does not exist yet. Build the toggle here —
it is one boolean in settings and §22 has been waiting on it.

---

## 6. Legacy rows

`FillAuditRecord` rows live in IndexedDB (`storage/indexed-db.ts`), NOT in the
key-value store that `runMigrations` walks — `MIGRATIONS` in
`storage/migrations.ts` is still an empty array and is the wrong tool here. Do
not bump `DB_VERSION` for this.

Normalise on read instead, in the repository: a row with no `outcome` becomes
`'corrected_legacy'` when its `userCorrected` was true, `'unreviewed'`
otherwise. `'corrected_legacy'` is counted in no numerator and excluded from
every denominator. One comment saying why.

---

## 7. Testing

Name the tests after the bugs, the way
`does NOT select West Virginia for an applicant in Virginia` is named:

1. `does not count a user teaching us a blank field as an incorrect fill`
   — a `'skip'` row corrected to a real path produces `'assigned_unmapped'`
   and leaves the incorrect-fill numerator at zero.
2. `one correction on a repeated question counts once, not once per run`
   — three runs, same fingerprint, one correction; numerator is 1 and the
   denominator does not include the superseded rows.
3. `an unreviewed row is not evidence of a correct fill`
   — 100 filled rows, no corrections; the rate reports 0 with `reviewed: 0`
   and the renderer says "not enough evidence" rather than "0%".
4. `a legacy row is excluded from both sides of every rate`.
5. An assertion from OUTSIDE the type — in the style of the redaction block in
   `tests/audit/join.test.ts` — that the incorrect-fill numerator accepts
   only `corrected_wrong_fill` and `rejected_to_none`. A future contributor
   adding a seventh outcome must fail a test, not silently change a metric.

Update the existing audit tests that construct `userCorrected` rows
(`tests/audit/*.test.ts`, `tests/options/history.test.tsx`).

---

## 8. Acceptance criteria

1. `npm run verify` is clean; test count goes up, none are deleted to make room.
2. No user-facing string changes in the history view.
3. Grepping the codebase for `userCorrected` returns only the legacy-read
   comment in the repository.
4. `computeMetrics` has no import from storage, chrome, or React.
5. The developer toggle defaults OFF and the metrics view is unreachable
   without it.
6. `IMPLEMENTATION_STATUS.md` and `gaps.md` updated: §26 moves from "nothing
   exists" to "four of seven computed; reuse rate needs a cache-hit signal;
   precision belongs to the fixture corpus".

---

## 9. Guardrails — not yours to change

- No applicant value enters `FillAuditRecord`. The type comment at the top
  of `audit/types.ts` explains why; the redaction test asserts it from outside.
  Metrics need counts, never answers.
- No new network call. Metrics are local and stay local.
- Do not touch the confidence policy, the adapters, or `decideFill`. This
  work measures the system; it does not tune it.
- Do not add a fill-rate number to the user-facing panel. §26 is explicit
  that raw fill rate is the wrong thing to optimise, and putting it on screen is
  how it starts being optimised.

---

## 10. Suggested order of work

1. `FieldOutcome` type + pure derivation function + its unit tests. No wiring.
2. Repository: `recordOutcome`, supersession, legacy read-normalisation.
3. `join.ts` and `countRun` writers; update existing tests.
4. `userInitiated` through the fill-report schema, side panel, join.
5. `metrics.ts` + tests 1–5.
6. Developer toggle + the metrics view.
7. Update `IMPLEMENTATION_STATUS.md` and `gaps.md`.

Commit at each step, not once at the end.
