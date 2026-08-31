/**
 * Test doubles for the semantic port.
 *
 * Real code implementing a real interface, in the style the rest of this suite
 * uses (engineering.md practice #7) - no mocking framework, nothing patched.
 *
 * The fake RECORDS every request it is given, which is what makes the most
 * important test in this package possible: serialising what was actually sent
 * and asserting the applicant's data is not in it.
 */
import { err, ok, type Result } from '@shared/result';
import { AppError } from '@shared/errors';
import type {
  ConceptAnswer,
  ConceptQuestion,
  OptionChoiceAnswer,
  OptionChoiceQuestion,
  SemanticPort,
} from '@semantic/port';

export class FakeSemanticPort implements SemanticPort {
  /** Every stage-1 batch, in order. One entry per CALL, not per question. */
  readonly conceptCalls: Array<readonly ConceptQuestion[]> = [];
  /** Every stage-2 request, in order. */
  readonly optionCalls: OptionChoiceQuestion[] = [];

  constructor(
    private readonly behaviour: {
      /** Answer for a given question, by field id. Absent means `null`. */
      concepts?: Record<string, string | null>;
      /** Stage-2 answer, by field id. */
      options?: Record<string, string | null>;
      /** When set, stage 1 fails with this error instead of answering. */
      conceptError?: AppError;
      /** When set, stage 2 fails with this error instead of answering. */
      optionError?: AppError;
    } = {},
  ) {}

  async identifyConcepts(
    questions: readonly ConceptQuestion[],
  ): Promise<Result<readonly ConceptAnswer[], AppError>> {
    this.conceptCalls.push(questions);
    if (this.behaviour.conceptError !== undefined) return err(this.behaviour.conceptError);

    return ok(
      questions.map((question) => ({
        fieldId: question.fieldId,
        profilePath: this.behaviour.concepts?.[question.fieldId] ?? null,
      })),
    );
  }

  async chooseOption(
    question: OptionChoiceQuestion,
  ): Promise<Result<OptionChoiceAnswer, AppError>> {
    this.optionCalls.push(question);
    if (this.behaviour.optionError !== undefined) return err(this.behaviour.optionError);

    return ok({
      fieldId: question.fieldId,
      optionLabel: this.behaviour.options?.[question.fieldId] ?? null,
    });
  }

  /** Total calls of both kinds. The number several tests assert is zero. */
  get callCount(): number {
    return this.conceptCalls.length + this.optionCalls.length;
  }
}

/** A port that must never be reached. Fails loudly if it is. */
export class ForbiddenSemanticPort implements SemanticPort {
  async identifyConcepts(): Promise<never> {
    throw new Error('stage 1 was called when it should not have been');
  }
  async chooseOption(): Promise<never> {
    throw new Error('stage 2 was called when it should not have been');
  }
}
