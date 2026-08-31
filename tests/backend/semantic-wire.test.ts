/**
 * The semantic fallback's wire format, and the real port over the gateway.
 *
 * `tests/semantic/` proves the reasoning is right against a fake. This file
 * proves the thing that actually goes on the wire is right, which is a
 * different question and the one `engineering.md` practice #3 is about: the
 * seam between our code and somebody else's is where the tests were not
 * looking the last time this repo lost a day.
 *
 * The assertions are mostly about what the schemas REFUSE, because a schema is
 * the only control here that a prompt cannot talk its way past.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendGateway } from '@backend/gateway';
import { __setBackendOriginForTesting } from '@backend/config';
import { createSemanticPort } from '@backend/semantic';
import {
  conceptReplySchema,
  conceptRequestSchema,
  optionChoiceReplySchema,
  SEMANTIC_LIMITS,
} from '@backend/schemas';
import { InMemoryStore } from '@storage/key-value-store';
import { STORAGE_KEYS } from '@storage/keys';

beforeEach(() => {
  __setBackendOriginForTesting('https://api.example.com');
});

/** A gateway whose fetch returns `body`, and the spy so we can read the request. */
async function portWithReply(body: unknown, status = 200) {
  const store = new InMemoryStore();
  await store.set(STORAGE_KEYS.deviceToken, 'device-token-abc');

  const fetchSpy = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );

  const gateway = new BackendGateway(store, { fetchImpl: fetchSpy as unknown as typeof fetch });
  return { port: createSemanticPort(gateway), fetchSpy };
}

/** The parsed JSON body of the nth request. */
const bodyOf = (fetchSpy: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> =>
  JSON.parse((fetchSpy.mock.calls[index]?.[1] as RequestInit).body as string);

const question = {
  fieldId: 'field-1',
  question: 'which campus did you attend',
  kind: 'select' as const,
  options: ['Rutgers - New Brunswick', 'Rutgers - Newark'],
};

describe('stage 1 over the wire', () => {
  it('posts to the semantic endpoint and returns the answers', async () => {
    const { port, fetchSpy } = await portWithReply({
      concepts: [{ fieldId: 'field-1', profilePath: 'education[0].institution' }],
    });

    const reply = await port.identifyConcepts([question]);

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/semantic/concepts');
    expect(reply.ok && reply.value[0]?.profilePath).toBe('education[0].institution');
  });

  it('sends the page\'s words under an `untrusted` key, structurally separate', async () => {
    // Rule 1 of schemas.ts. A `<label>` reading "ignore previous instructions"
    // is a live prompt injection, and the defence is that page text NEVER
    // occupies the same slot as an instruction - not that the prompt asks
    // nicely.
    const { port, fetchSpy } = await portWithReply({ concepts: [] });
    await port.identifyConcepts([question]);

    const body = bodyOf(fetchSpy);
    expect(body).toHaveProperty('untrusted');
    expect(JSON.stringify(body.untrusted)).toContain('which campus did you attend');
    // There is no key at the top level holding free text that a backend could
    // mistake for an instruction.
    expect(body).not.toHaveProperty('question');
    expect(body).not.toHaveProperty('prompt');
  });

  it('sends no profile data, no URL, and no hostname', async () => {
    const { port, fetchSpy } = await portWithReply({ concepts: [] });
    await port.identifyConcepts([question]);

    const body = JSON.stringify(bodyOf(fetchSpy));
    for (const absent of ['boards.example.com', 'https://', 'Nitu', 'nitu@example.com', '609']) {
      expect(body).not.toContain(absent);
    }
  });

  it('sends the path vocabulary, which is our schema and not the user\'s data', async () => {
    // Identical for every install. Sending it is what keeps the model's answers
    // inside the set we can actually use, so the "unknown path" refusal is a
    // backstop rather than the common case.
    const { port, fetchSpy } = await portWithReply({ concepts: [] });
    await port.identifyConcepts([question]);

    const body = bodyOf(fetchSpy);
    expect(body.allowedPaths).toContain('education[0].institution');
    expect(body.allowedPaths).toContain('contact.city');
  });

  it('rejects a reply that is not the expected shape', async () => {
    const { port } = await portWithReply({ concepts: 'education[0].institution' });
    const reply = await port.identifyConcepts([question]);

    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.error.code).toBe('BACKEND_REJECTED');
  });

  it('surfaces a transport failure rather than inventing an answer', async () => {
    const { port } = await portWithReply({ error: 'nope' }, 500);
    const reply = await port.identifyConcepts([question]);

    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.error.code).toBe('BACKEND_REJECTED');
  });

  it('makes no request at all for an empty batch', async () => {
    const { port, fetchSpy } = await portWithReply({ concepts: [] });
    const reply = await port.identifyConcepts([]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reply.ok && reply.value).toEqual([]);
  });

  it('truncates rather than rejecting an absurdly long label from a hostile page', async () => {
    const { port, fetchSpy } = await portWithReply({ concepts: [] });
    await port.identifyConcepts([{ ...question, question: 'x'.repeat(50_000) }]);

    const body = bodyOf(fetchSpy);
    const sent = (body.untrusted as Array<{ question: string }>)[0];
    expect(sent?.question.length).toBeLessThanOrEqual(SEMANTIC_LIMITS.question);
  });

  it('caps how many questions one page can send', async () => {
    const { port, fetchSpy } = await portWithReply({ concepts: [] });
    const many = Array.from({ length: 500 }, (_, i) => ({ ...question, fieldId: `f${i}` }));
    await port.identifyConcepts(many);

    const body = bodyOf(fetchSpy);
    expect((body.untrusted as unknown[]).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.questions);
  });
});

describe('stage 2 over the wire', () => {
  it('sends one value and that field\'s options, and returns the choice', async () => {
    const { port, fetchSpy } = await portWithReply({ fieldId: 'field-1', optionLabel: '3-5 years' });

    const reply = await port.chooseOption({
      fieldId: 'field-1',
      value: '4',
      options: ['1-3 years', '3-5 years'],
    });

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/semantic/option');
    expect(reply.ok && reply.value.optionLabel).toBe('3-5 years');

    const body = bodyOf(fetchSpy);
    expect(body.value).toBe('4');
    expect(JSON.stringify(body.untrusted)).toContain('3-5 years');
  });

  it('rejects a reply carrying anything that could name a form control', async () => {
    // The single most important property of these schemas: a reply may describe
    // a VALUE, never an ACTION. Zod strips what is not declared, so an
    // adversarial backend cannot smuggle a selector or a fill instruction
    // through into our code.
    const parsed = optionChoiceReplySchema.safeParse({
      fieldId: 'field-1',
      optionLabel: '3-5 years',
      selector: '#salary',
      action: 'fill',
      profilePath: 'applicationPreferences.desiredSalary',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ fieldId: 'field-1', optionLabel: '3-5 years' });
  });

  it('strips control and bidi characters from a returned label', async () => {
    // U+202E reverses the display of everything after it. A label that reads as
    // one option and matches another is exactly the kind of thing an extension
    // claiming the user can trust what they see must not pass through.
    const { port } = await portWithReply({ fieldId: 'field-1', optionLabel: '3-5‮ years' });
    const reply = await port.chooseOption({ fieldId: 'field-1', value: '4', options: ['3-5 years'] });

    expect(reply.ok && reply.value.optionLabel).toBe('3-5 years');
  });
});

describe('the schemas themselves', () => {
  it('accepts a well-formed stage-1 request', () => {
    expect(
      conceptRequestSchema.safeParse({
        untrusted: [question],
        allowedPaths: ['contact.city'],
      }).success,
    ).toBe(true);
  });

  it('refuses a stage-1 request with more questions than the cap', () => {
    expect(
      conceptRequestSchema.safeParse({
        untrusted: Array.from({ length: SEMANTIC_LIMITS.questions + 1 }, () => question),
        allowedPaths: [],
      }).success,
    ).toBe(false);
  });

  it('accepts a null concept, which is a real answer', () => {
    expect(
      conceptReplySchema.safeParse({ concepts: [{ fieldId: 'f1', profilePath: null }] }).success,
    ).toBe(true);
  });

  it('refuses a concept reply whose path is not a string', () => {
    expect(
      conceptReplySchema.safeParse({ concepts: [{ fieldId: 'f1', profilePath: 42 }] }).success,
    ).toBe(false);
  });

  it('refuses a concept reply longer than any real page could need', () => {
    expect(
      conceptReplySchema.safeParse({
        concepts: Array.from({ length: SEMANTIC_LIMITS.questions + 1 }, () => ({
          fieldId: 'f1',
          profilePath: null,
        })),
      }).success,
    ).toBe(false);
  });
});
