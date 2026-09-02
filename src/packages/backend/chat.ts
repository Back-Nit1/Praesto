/**
 * Chat client.
 * ---------------------------------------------------------------------------
 * The one function the future chat UI calls. Thin on purpose: the gateway owns
 * transport, budget and bounds; `schemas.ts` owns what may cross the wire and
 * why. What is left here is the small amount of glue, plus the two rules that
 * are easiest to get wrong at a call site and so are enforced once, here.
 *
 * RULE 1 - THE UNTRUSTED/TRUSTED SPLIT IS NOT OPTIONAL.
 * `ask()` takes the user's question and page-derived context as SEPARATE
 * parameters. There is no overload that accepts one blob. A caller cannot
 * accidentally concatenate a job description into the user's prompt, because
 * the type system gives it nowhere to do so.
 *
 * RULE 2 - THE REPLY IS TEXT THE USER READS.
 * It is sanitised and returned. It is not an instruction, it does not name a
 * field, and nothing downstream may turn it into a fill without the user
 * putting it there. See the header of `schemas.ts`.
 */
import { AppError } from '@shared/errors';
import { err, ok, type Result } from '@shared/result';
import type { BackendGateway } from './gateway';
import {
  chatReplySchema,
  sanitizeModelText,
  type ChatReply,
  type ChatTurn,
  type UntrustedText,
} from './schemas';
import { CHAT_LIMITS } from './schemas';

/** What a caller may attach to a question, and what happens to each part. */
export interface AskOptions {
  /**
   * Text the user did not write: page labels, a job description, resume lines.
   * Travels separately all the way to the model. Bounded here as well as by
   * the schema, so an over-eager caller truncates rather than being rejected.
   */
  context?: readonly UntrustedText[];
  /** Prior turns, oldest first. Trimmed to the most recent, not the first. */
  history?: readonly ChatTurn[];
}

/**
 * Ask the backend a question.
 *
 * @param gateway  the single network choke point
 * @param question what the USER typed - the only text treated as instruction
 */
export async function ask(
  gateway: BackendGateway,
  question: string,
  options: AskOptions = {},
): Promise<Result<ChatReply, AppError>> {
  const trimmed = question.trim();
  if (trimmed.length === 0) {
    // Refused before the request: sending it would spend a unit of the user's
    // daily budget on nothing.
    return err(new AppError('SCHEMA_VALIDATION_FAILED', 'Ask a question first'));
  }

  /**
   * History is trimmed from the FRONT.
   *
   * Keeping the oldest turns and dropping the newest would answer the
   * conversation the user is no longer having. `slice(-n)` is O(n) in the kept
   * portion, not in the whole history.
   */
  const history = (options.history ?? []).slice(-CHAT_LIMITS.historyTurns);
  const context = (options.context ?? []).slice(0, CHAT_LIMITS.untrustedItems);

  const reply = await gateway.post(
    '/v1/chat',
    {
      question: trimmed.slice(0, CHAT_LIMITS.question),
      untrusted: context,
      history,
    },
    chatReplySchema,
  );

  if (!reply.ok) return reply;

  // The model's words, made safe to display. See sanitizeModelText for what
  // "safe" means here - it is about bidi and control characters, not markup;
  // React already handles markup.
  return ok({ ...reply.value, text: sanitizeModelText(reply.value.text) });
}
