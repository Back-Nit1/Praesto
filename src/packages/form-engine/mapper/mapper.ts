/**
 * The semantic field mapper.
 * ---------------------------------------------------------------------------
 * Answers exactly one question, and nothing else:
 *
 *     "What canonical concept is this webpage field asking for?"
 *
 * It does NOT read the applicant profile, does not touch the DOM, does not
 * format values, and does not decide whether to fill. Those are the resolver's,
 * the fill engine's, and the confidence policy's jobs respectively. The
 * discipline pays off directly: this file is a pure function from a plain
 * object to a plain object, so every mapping rule in the product can be tested
 * without a browser, a profile, or a fixture page.
 *
 * SCORE-AND-SELECT, NOT FIRST-MATCH-WINS
 *
 * Spec section 12.1 lists the cascade as an ordered sequence. We implement it
 * as: run every strategy, collect candidates, then select. This is a deliberate
 * deviation, and it is strictly more informative for three reasons:
 *
 *   1. AGREEMENT IS EVIDENCE. If `autocomplete="given-name"` and the label
 *      "First name" both point at legalFirstName, that is worth slightly more
 *      than either alone. A first-match cascade returns after the first hit and
 *      never learns that the second signal agreed.
 *
 *   2. DISAGREEMENT IS EVIDENCE TOO. When the alias table says one thing and a
 *      learned user correction says another, we want to SEE the conflict and
 *      resolve it by an explicit precedence rule. A first-match cascade hides
 *      it behind whichever strategy happened to run first.
 *
 *   3. AMBIGUITY BECOMES VISIBLE. Alternatives are reported rather than
 *      discarded, so "start date" matching both education and employment is
 *      surfaced as an ambiguity instead of silently resolving to one.
 *
 * The spec's ordering is preserved exactly - as the score ranking in the
 * confidence policy, and as the explicit override rules below.
 */
import { requiresVerifiedValue, type ProfilePath } from '@profile/paths';
import type { LearnedMappingLookup } from '@learning/types';
import { EMPTY_LOOKUP } from '@learning/types';
import {
  combineConfidence,
  DEFAULT_CONFIDENCE_POLICY,
  type ConfidencePolicyConfig,
} from '../confidence/policy';
import {
  attributeNameVariants,
  containmentScore,
  containsNegation,
  normalizeAttributeName,
  normalizeLabel,
  stripFiller,
  tokenSimilarity,
} from '../descriptor/normalize';
import type { FieldDescriptor } from '../descriptor/types';
import { computeFingerprints, selectQuestionText } from '../fingerprints/fingerprint';
import { ALIAS_INDEX, AUTOCOMPLETE_MAP, COMPACT_ALIAS_INDEX } from './aliases';
import { unknownMapping, type FieldMappingResult, type MappingReason, type MappingSource } from './types';

/**
 * An ATS-specific mapping rule.
 *
 * Defined here as a plain function type so the mapper can accept rules without
 * importing any ATS package - keeping the dependency arrow pointing from ATS
 * adapters toward the generic engine, never the reverse (spec section 28: "do
 * not put ATS-specific selectors in generic mapper modules").
 */
export type ATSMappingRule = (descriptor: FieldDescriptor) => ProfilePath | null;

export interface MapFieldOptions {
  /** Learned corrections. Defaults to knowing nothing. */
  learned?: LearnedMappingLookup;
  /** Rules contributed by the detected ATS adapter. */
  atsRules?: readonly ATSMappingRule[];
  config?: ConfidencePolicyConfig;
}

/** One strategy's proposal, before selection. */
interface Candidate {
  path: ProfilePath;
  /** Base score from the confidence policy's source table. */
  score: number;
  source: MappingSource;
  reason: MappingReason;
  /**
   * Bypasses normal scoring. Set only for a user-confirmed learned mapping:
   * the user's explicit instruction is not a signal to be weighed against our
   * heuristics, it is an answer that replaces them.
   */
  override?: boolean;
  /** History attached to a learned mapping, feeding the confidence adjustment. */
  successfulUses?: number;
  correctedUses?: number;
}

/**
 * Map one field to a canonical profile path.
 *
 * Pure: same descriptor plus same options always yields the same result. That
 * property is what makes a mapping bug reproducible from a test fixture instead
 * of only from a live webpage.
 */
export function mapField(
  descriptor: FieldDescriptor,
  options: MapFieldOptions = {},
): FieldMappingResult {
  const config = options.config ?? DEFAULT_CONFIDENCE_POLICY;
  const learned = options.learned ?? EMPTY_LOOKUP;

  // A control we cannot drive, or one the page has disabled, is not worth
  // mapping: even a perfect mapping could not be acted on.
  if (descriptor.kind === 'unsupported' || descriptor.disabled) {
    return unknownMapping(descriptor.localId, [
      { signal: 'option_shape', detail: 'Control is unsupported or disabled' },
    ]);
  }

  const candidates: Candidate[] = [];

  // The question as a human would read it, already normalized.
  const question = selectQuestionText(descriptor);

  // --- 1. HTML semantics: the autocomplete attribute -----------------------
  // Strongest signal, because it is the page author declaring the field's
  // meaning in a standard vocabulary rather than us interpreting their prose.
  if (descriptor.autocomplete !== undefined) {
    // The attribute may carry section/billing tokens ("shipping given-name").
    // The meaning is in the last token; the rest is address-context we ignore.
    const tokens = descriptor.autocomplete.toLowerCase().trim().split(/\s+/);
    const meaningful = tokens[tokens.length - 1];
    const mapped = meaningful === undefined ? undefined : AUTOCOMPLETE_MAP[meaningful];
    if (mapped !== undefined) {
      candidates.push({
        path: mapped,
        score: config.sourceScores.autocomplete,
        source: 'html',
        reason: {
          signal: 'autocomplete',
          matched: meaningful,
          score: config.sourceScores.autocomplete,
        },
      });
    }
    // An unrecognised token contributes NOTHING. Sites emit "off", "nope", and
    // template leftovers; treating an unknown token as meaningful would turn
    // noise into a signal.
  }

  // --- 2. Exact alias match on the human-readable question -----------------
  pushAliasCandidates(question, 'label_exact', config.sourceScores.exactAlias, 'alias', candidates);

  // --- 3. ATS-specific rules ----------------------------------------------
  for (const rule of options.atsRules ?? []) {
    const path = rule(descriptor);
    if (path !== null) {
      candidates.push({
        path,
        score: config.sourceScores.atsRule,
        source: 'ats',
        reason: { signal: 'ats_rule', detail: descriptor.ats, score: config.sourceScores.atsRule },
      });
    }
  }

  // --- 4. Learned mappings from past user corrections ----------------------
  const fingerprints = computeFingerprints(descriptor);
  const learnedMatch = learned.find(fingerprints);
  if (learnedMatch !== null) {
    candidates.push({
      path: learnedMatch.profilePath as ProfilePath,
      score: config.sourceScores.learnedMapping,
      source: 'memory',
      // A user-confirmed correction is an instruction, not a hint.
      ...(learnedMatch.userConfirmed ? { override: true } : {}),
      successfulUses: learnedMatch.successfulUses,
      correctedUses: learnedMatch.correctedUses,
      reason: {
        signal: 'learned_mapping',
        matched: learnedMatch.normalizedLabel ?? learnedMatch.semanticFingerprint,
        detail: `scope=${learnedMatch.scope}, confirmed=${learnedMatch.userConfirmed}`,
        score: config.sourceScores.learnedMapping,
      },
    });
  }

  // --- 5. Exact alias match on the name/id attributes ----------------------
  // Slightly below the label match: attributes are written for machines and are
  // more often abbreviated, reused across templates, or simply stale.
  //
  // Each attribute yields several readings, because real ATS markup namespaces
  // its inputs (`job_application[email]`). A reading the author explicitly
  // delimited scores like any other attribute match; a reading we produced by
  // truncating scores far lower, since dropping a prefix can invert meaning.
  for (const attribute of [descriptor.name, descriptor.id]) {
    for (const variant of attributeNameVariants(attribute)) {
      const score =
        variant.kind === 'suffix'
          ? config.sourceScores.attributeSuffix
          : config.sourceScores.nameAttribute;
      pushAliasCandidates(variant.text, 'name_exact', score, 'alias', candidates);
    }
  }

  // --- 6. Compact match (separators collapsed) -----------------------------
  // Reaches `name="e_mail_address"` and `id="firstname"`. Lossy, hence scored
  // below the exact forms.
  const compactSources = [question, normalizeAttributeName(descriptor.name), normalizeAttributeName(descriptor.id)];
  for (const source of compactSources) {
    const compact = source.replace(/[^a-z0-9]/g, '');
    if (compact.length < 3) continue; // 1-2 characters match by accident
    const paths = COMPACT_ALIAS_INDEX.get(compact);
    if (paths === undefined) continue;
    for (const path of paths) {
      candidates.push({
        path,
        score: config.sourceScores.compactAlias,
        source: 'alias',
        reason: { signal: 'compact_match', matched: compact, score: config.sourceScores.compactAlias },
      });
    }
  }

  // --- 7. Fuzzy token similarity ------------------------------------------
  // Last resort, and capped BELOW the autofill threshold by the policy's score
  // table: a fuzzy match can produce a suggestion, never an automatic fill.
  if (question.length > 0) {
    const fuzzy = bestFuzzyMatch(question);
    if (fuzzy !== null) {
      candidates.push({
        path: fuzzy.path,
        // Scale the base score by the similarity so a weak resemblance scores
        // proportionally lower rather than getting the full fuzzy score.
        score: config.sourceScores.fuzzy * fuzzy.similarity,
        source: 'fuzzy',
        reason: {
          signal: 'fuzzy_label',
          matched: fuzzy.alias,
          score: config.sourceScores.fuzzy * fuzzy.similarity,
          detail: `similarity=${fuzzy.similarity.toFixed(2)}`,
        },
      });
    }
  }

  if (candidates.length === 0) {
    return unknownMapping(descriptor.localId, [
      { signal: 'ambiguous_alias', detail: 'No signal matched any known concept' },
    ]);
  }

  return selectWinner(descriptor, question, candidates, config);
}

/** Add every path claiming this exact normalized string. */
function pushAliasCandidates(
  normalized: string,
  signal: MappingReason['signal'],
  score: number,
  source: MappingSource,
  out: Candidate[],
): void {
  if (normalized.length === 0) return;

  // Try the string as-is first, then with pure boilerplate removed ("please
  // enter your email address" -> "enter email address"). Filler stripping never
  // removes a word that could change meaning - see descriptor/normalize.ts.
  for (const key of [normalized, stripFiller(normalized)]) {
    const paths = ALIAS_INDEX.get(key);
    if (paths === undefined) continue;
    for (const path of paths) {
      out.push({ path, score, source, reason: { signal, matched: key, score } });
    }
    // First hit wins between the two forms: the unstripped match is the more
    // faithful one, and adding both would double-count a single agreement.
    return;
  }
}

/** Best fuzzy match across the whole alias table. */
function bestFuzzyMatch(
  question: string,
): { path: ProfilePath; alias: string; similarity: number } | null {
  /**
   * Below this, a token overlap is noise. Two unrelated form labels routinely
   * share a common word ("date", "name", "number"), and a low-similarity match
   * on a shared word is how a mapper starts producing confident nonsense.
   */
  const MIN_SIMILARITY = 0.6;

  let best: { path: ProfilePath; alias: string; similarity: number } | null = null;

  for (const [alias, paths] of ALIAS_INDEX) {
    // Blend the two measures: Jaccard punishes extra words in either string,
    // containment rewards one string fully appearing inside the other. Weighted
    // toward Jaccard because containment alone would score the single word
    // "date" as a perfect match for "graduation date".
    const jaccard = tokenSimilarity(question, alias);
    const containment = containmentScore(question, alias);
    const similarity = jaccard * 0.7 + containment * 0.3;

    if (similarity < MIN_SIMILARITY) continue;
    if (best !== null && similarity <= best.similarity) continue;

    const path = paths[0];
    if (path === undefined) continue;
    best = { path, alias, similarity };
  }

  return best;
}

/**
 * How close a rival must be before the mapping counts as contested.
 *
 * Sized to sit between adjacent tiers of the source table: an exact label match
 * (0.97) and an exact name match (0.96) pointing at DIFFERENT paths is a real
 * disagreement worth flagging, while a fuzzy match (~0.8) losing to an exact one
 * is simply the cascade working.
 */
const CONTEST_MARGIN = 0.05;

/**
 * Pick the winning candidate and compute the final confidence.
 *
 * The selection rules, in order:
 *   1. A user-confirmed learned mapping wins outright.
 *   2. Otherwise, the highest base score wins.
 *   3. Agreement between distinct sources adds a small bonus.
 *   4. Disagreement between HIGH-scoring candidates for DIFFERENT paths is
 *      genuine ambiguity and costs confidence.
 *   5. An unmodelled negation in the question costs a lot.
 */
function selectWinner(
  descriptor: FieldDescriptor,
  question: string,
  candidates: Candidate[],
  config: ConfidencePolicyConfig,
): FieldMappingResult {
  // Highest score first; a user override sorts above everything.
  const sorted = [...candidates].sort((a, b) => {
    if (a.override === true && b.override !== true) return -1;
    if (b.override === true && a.override !== true) return 1;
    return b.score - a.score;
  });

  const winner = sorted[0];
  if (winner === undefined) return unknownMapping(descriptor.localId);

  // How many DISTINCT sources independently proposed the winning path. Distinct
  // sources, not distinct candidates: the alias table matching both `name` and
  // `id` is one piece of evidence expressed twice, not two.
  const agreeingSources = new Set(
    sorted.filter((c) => c.path === winner.path).map((c) => c.source),
  );
  const agreeingSignals = Math.max(0, agreeingSources.size - 1);

  const reasons: MappingReason[] = sorted
    .filter((c) => c.path === winner.path)
    .map((c) => c.reason);

  // --- ambiguity detection -------------------------------------------------
  // A strong competing candidate for a DIFFERENT path means the question is
  // genuinely ambiguous ("start date" under no section heading). We report it
  // and pay for it, rather than presenting our first choice as certain.
  const rivals = sorted.filter((c) => c.path !== winner.path);
  const strongestRival = rivals[0];

  // Two winners are immune to the ambiguity penalty, for the same underlying
  // reason: they are not interpretations competing with other interpretations,
  // they are declarations.
  //
  //   html      the page author stated the field's meaning in a standard
  //             vocabulary. A generic label like "Name" sitting next to
  //             `autocomplete="given-name"` is not a rival reading - it is a
  //             less precise restatement, and the precise one wins.
  //   override  the user personally told us what this field means.
  //
  // Without this, a page that does everything right (a correct autocomplete
  // attribute AND a human label) would be punished for the label being vaguer
  // than the attribute - penalising exactly the markup we most want to trust.
  const winnerIsDeclaration = winner.source === 'html' || winner.override === true;
  const contested =
    strongestRival !== undefined &&
    strongestRival.score >= winner.score - CONTEST_MARGIN &&
    !winnerIsDeclaration;

  if (contested && strongestRival !== undefined) {
    reasons.push({
      signal: 'ambiguous_alias',
      matched: strongestRival.path,
      detail: `Competing interpretation scored ${strongestRival.score.toFixed(2)}`,
    });
  }

  // --- negation ------------------------------------------------------------
  // We do not yet model inverted phrasings, so detecting one is a reason to
  // stand down rather than to answer. Sensitive paths are exempt from the
  // penalty ONLY in the sense that the policy already refuses to autofill them
  // without user verification - the penalty still applies to the score, which
  // keeps the field visible as "needs review" rather than filled.
  const hasUnmodelledNegation = containsNegation(question);
  if (hasUnmodelledNegation) {
    reasons.push({
      signal: 'negation_detected',
      detail: 'Question contains a negation; polarity is not modelled, so confidence is reduced',
    });
  }

  let confidence = combineConfidence(
    winner.score,
    {
      agreeingSignals,
      hasUnmodelledNegation,
      ...(winner.successfulUses !== undefined ? { successfulUses: winner.successfulUses } : {}),
      ...(winner.correctedUses !== undefined ? { correctedUses: winner.correctedUses } : {}),
    },
    config,
  );

  // Contested mappings are pushed below the autofill line. Not zeroed: the
  // interpretation is probably right and worth suggesting - it just must not be
  // acted on without a human looking at it.
  if (contested) {
    confidence = Math.min(confidence, config.autofillThreshold - 0.01);
  }

  const knowledgeState = deriveKnowledgeState(winner, confidence, config);

  const result: FieldMappingResult = {
    fieldId: descriptor.localId,
    profilePath: winner.path,
    confidence,
    knowledgeState,
    reasons,
    source: winner.source,
  };

  if (rivals.length > 0) {
    // Deduplicate by path, keeping each rival's best score, so the debug view
    // shows distinct interpretations rather than repeated ones.
    const seen = new Map<ProfilePath, number>();
    for (const rival of rivals) {
      const previous = seen.get(rival.path);
      if (previous === undefined || rival.score > previous) seen.set(rival.path, rival.score);
    }
    result.alternatives = [...seen.entries()].map(([path, score]) => ({
      profilePath: path,
      confidence: score,
    }));
  }

  return result;
}

/**
 * Translate a source and confidence into the five-state vocabulary.
 *
 * This is where spec section 12.3's states become a value the UI can branch on.
 * Note the sensitive-path rule: no matter how confident the MAPPING is, a
 * work-authorization or demographic question is never reported as `known`,
 * because knowing what is being asked is not the same as being entitled to
 * answer it.
 */
function deriveKnowledgeState(
  winner: Candidate,
  confidence: number,
  config: ConfidencePolicyConfig,
): FieldMappingResult['knowledgeState'] {
  if (requiresVerifiedValue(winner.path)) return 'previously_seen';
  if (winner.source === 'memory') return 'previously_seen';
  if (confidence >= config.autofillThreshold) return 'known';
  if (confidence >= config.suggestThreshold) return 'probable';
  return 'unknown';
}

/**
 * Map a batch of fields.
 *
 * A thin wrapper today, but the right place for future cross-field reasoning:
 * a "start date" directly beneath a matched "school name" is almost certainly
 * the education start date, and that inference needs the batch, not one field.
 * Having the seam already in place means adding it will not change any caller.
 */
export function mapFields(
  descriptors: readonly FieldDescriptor[],
  options: MapFieldOptions = {},
): FieldMappingResult[] {
  return descriptors.map((descriptor) => mapField(descriptor, options));
}

/** Re-exported so callers do not need a second import for the common case. */
export { normalizeLabel };
