/**
 * The semantic port, over the gateway.
 * ---------------------------------------------------------------------------
 * The `@semantic` package defines what it needs (`SemanticPort`); this is the
 * only implementation that touches a network, and it lives here rather than
 * there so that "what can this extension talk to" stays answerable by reading
 * one directory (`@backend`), and so that no test in `@semantic` can reach a
 * socket even by accident.
 *
 * Thin by design. Transport, budget, timeout, redirect refusal and response
 * bounding are the gateway's; what may cross the wire and why is `schemas.ts`.
 * What is left here is the mapping between the two vocabularies, plus the three
 * things that are easiest to get wrong at a call site:
 *
 *  1. TRUNCATE, DO NOT REJECT. A page that puts 50 KB in a `<label>` should
 *     cost its own tail, not the other nineteen questions on the form. Cutting
 *     here means the schema cap is a backstop rather than a failure mode a
 *     hostile page can trigger at will.
 *
 *  2. NEVER SEND AN EMPTY BATCH. A request with nothing in it still spends a
 *     unit of the user's daily budget.
 *
 *  3. SANITISE WHAT COMES BACK. Not for markup - nothing here is rendered as
 *     HTML - but for the bidi and control characters that make text read as
 *     something other than what it is. An extension whose proposition is that
 *     the user can trust what they see must not pass those through, even into
 *     a string that is about to be compared rather than displayed.
 */
import type { AppError } from '@shared/errors';
import { ok, type Result } from '@shared/result';
import { SCALAR_PROFILE_PATHS } from '@profile/paths';
import type {
  ConceptAnswer,
  ConceptQuestion,
  OptionChoiceAnswer,
  OptionChoiceQuestion,
  SemanticPort,
} from '@semantic/port';
import type { BackendGateway } from './gateway';
import {
  conceptReplySchema,
  optionChoiceReplySchema,
  sanitizeModelText,
  SEMANTIC_LIMITS,
  type SemanticQuestion,
} from './schemas';

const CONCEPTS_PATH = '/v1/semantic/concepts';
const OPTION_PATH = '/v1/semantic/option';

/**
 * The vocabulary of answers we can act on.
 *
 * Scalars are enumerable; the collection paths are not (they are indexed), so
 * the first entry of each is sent as the shape. Anything the model returns is
 * still validated against `isProfilePath` on the way back in - this list makes
 * a good answer likely, it does not make a bad one safe.
 *
 * Contains no personal data. It is the same list in every install, and it is
 * this repository's own schema.
 */
const ALLOWED_PATHS: readonly string[] = [
  ...SCALAR_PROFILE_PATHS,
  'education[0].institution',
  'education[0].degree',
  'education[0].fieldOfStudy',
  'education[0].startDate',
  'education[0].graduationDate',
  'education[0].gpa',
  'employment[0].company',
  'employment[0].title',
  'employment[0].location',
  'employment[0].startDate',
  'employment[0].endDate',
  'employment[0].description',
  'projects[0].name',
  'projects[0].description',
  'projects[0].url',
];

export function createSemanticPort(gateway: BackendGateway): SemanticPort {
  return {
    async identifyConcepts(
      questions: readonly ConceptQuestion[],
    ): Promise<Result<readonly ConceptAnswer[], AppError>> {
      // Nothing to ask is not a request. See note 2 in the header.
      if (questions.length === 0) return ok([]);

      const untrusted: SemanticQuestion[] = questions
        .slice(0, SEMANTIC_LIMITS.questions)
        .map((question) => ({
          fieldId: question.fieldId.slice(0, 64),
          question: question.question.slice(0, SEMANTIC_LIMITS.question),
          kind: question.kind,
          options: question.options
            .slice(0, SEMANTIC_LIMITS.options)
            .map((label) => label.slice(0, SEMANTIC_LIMITS.optionLabel)),
        }));

      const reply = await gateway.post(
        CONCEPTS_PATH,
        { untrusted, allowedPaths: ALLOWED_PATHS },
        conceptReplySchema,
      );
      if (!reply.ok) return reply;

      return ok(
        reply.value.concepts.map((concept) => ({
          fieldId: concept.fieldId,
          profilePath:
            concept.profilePath === null ? null : sanitizeModelText(concept.profilePath).trim(),
        })),
      );
    },

    async chooseOption(
      question: OptionChoiceQuestion,
    ): Promise<Result<OptionChoiceAnswer, AppError>> {
      const reply = await gateway.post(
        OPTION_PATH,
        {
          fieldId: question.fieldId.slice(0, 64),
          value: question.value.slice(0, SEMANTIC_LIMITS.value),
          untrusted: question.options
            .slice(0, SEMANTIC_LIMITS.options)
            .map((label) => label.slice(0, SEMANTIC_LIMITS.optionLabel)),
        },
        optionChoiceReplySchema,
      );
      if (!reply.ok) return reply;

      return ok({
        fieldId: reply.value.fieldId,
        optionLabel:
          reply.value.optionLabel === null ? null : sanitizeModelText(reply.value.optionLabel),
      });
    },
  };
}
