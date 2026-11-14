// Model-backed agent actions. Each one reads through an engine under the task's authorized context, asks the model for
// a schema-bound answer, checks that answer against the source text itself, and submits what survives ONLY as a proposal
// or a draft in the owning engine. No action here sends, publishes, assesses, approves or spends: those stay with people
// (or with explicit server-side grants and policy in the owning engine). Text taken from documents, replies and case
// files is passed to the model as data; nothing in it can add recipients, capabilities, tasks or instructions.
import { DomainError } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import type { ActionContext, ActionDefinition } from '../orchestration/index.ts';
import type { Runtime } from './compose.ts';
import { investigationProcessingPort } from './adapters.ts';
import type { ModelAnswer, ModelAsk, ModelPort } from './model.ts';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const str = (input: Json, key: string): string => {
  const v = (input as Any)?.[key];
  if (typeof v !== 'string' || v === '') throw new DomainError('invalid_input', `Task input "${key}" is required`);
  return v;
};
const obj = (properties: Record<string, unknown>): Record<string, unknown> => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const list = (items: Record<string, unknown>): Record<string, unknown> => ({ type: 'array', items });
const text = { type: 'string' };

/**
 * Asks the model once per task. The validated answer is checkpointed before anything is submitted, so a retried or
 * recovered task reuses it instead of paying for, and possibly getting a different, second answer.
 */
async function askOnce(a: ActionContext, model: ModelPort | null, request: ModelAsk): Promise<ModelAnswer> {
  const saved = (a.checkpoint as Any)?.answer as ModelAnswer | undefined;
  if (saved !== undefined) return saved;
  if (model === null) throw new DomainError('unavailable', 'No language model is configured for this deployment (set ANTHROPIC_API_KEY); this step needs a person or a configured model');
  const answer = await model.ask(request);
  await a.saveCheckpoint({ ...((a.checkpoint ?? {}) as Any), answer: answer as unknown as Json });
  return answer;
}
const usage = (answer: ModelAnswer): Json => ({ model: answer.model, inputTokens: answer.inputTokens, outputTokens: answer.outputTokens });
const estimate = () => ({ category: 'model.proposal', amount: 4000, unit: 'token' });

export function loadAgentActions(runtime: Runtime, model: ModelPort | null): Record<string, ActionDefinition> {
  const processing = investigationProcessingPort((short) => runtime.get(short));
  return {
    'agent.extract_claims': {
      description: 'Read one processed evidence version and propose claims, each tied to an exact quotation, for human review (input: evidenceRef, caseId?, focus?).',
      requires: ['processing:read', 'knowledge:propose'],
      estimate,
      async run(a) {
        const evidenceRef = str(a.task.input, 'evidenceRef'); const input = a.task.input as Any;
        const source = await processing.getText(a.ctx, evidenceRef) as Any;
        if (!source.available) throw new DomainError('unavailable', `No text is available for ${evidenceRef}: ${source.reason}`);
        const segments = source.segments as { text: string; selector: Any }[];
        const answer = await askOnce(a, model, {
          instruction: [
            'Identify the factual claims made in the document below that matter to an investigation. For each claim give: a neutral one-sentence statement of the claim; its type; and one quotation copied exactly from the document that states it.',
            'Types: "allegation" (asserted, unproven), "attributed_statement" (the document reports what a named source said), "observation" (the document itself directly records it, e.g. a date on a form), "inference" (follows from the text but is not stated).',
            'Do not add claims the document does not make. At most 25 claims.',
            ...(typeof input.focus === 'string' && input.focus !== '' ? [`The investigators' question for this document (written by staff): ${input.focus.slice(0, 1000)}`] : []),
          ].join('\n'),
          material: [{ label: `document ${evidenceRef}`, text: segments.map((s) => s.text).join('\n') }],
          schema: obj({ claims: list(obj({ statement: text, type: { type: 'string', enum: ['allegation', 'attributed_statement', 'observation', 'inference'] }, quote: text })) }),
        });
        // A claim is kept only when its quotation really occurs in one segment of the preserved text.
        const items: Any[] = []; let dropped = 0;
        for (const c of ((answer.output as Any).claims as Any[]).slice(0, 25)) {
          const quote = String(c.quote).trim(); const statement = String(c.statement).trim().slice(0, 2000);
          const segment = quote.length < 8 ? undefined : segments.find((s) => s.text.includes(quote));
          if (segment === undefined || statement === '') { dropped++; continue; }
          const start = segment.text.indexOf(quote);
          items.push({ text: statement, claimType: c.type, evidence: [{ evidenceRef, representationRef: source.derivativeRef, stance: 'context',
            selector: { kind: 'text', quote: segment.text, ...(typeof segment.selector.segmentId === 'string' ? { segmentId: segment.selector.segmentId } : {}), ...(typeof segment.selector.page === 'number' ? { page: segment.selector.page } : {}) },
            excerpt: { start, end: start + quote.length, quote } }] });
        }
        const proposals = items.length === 0 ? [] : await runtime.get('knowledge').proposeClaims(a.ctx, { origin: { kind: 'model', ref: evidenceRef, label: answer.model }, items,
          ...(typeof input.caseId === 'string' ? { caseId: input.caseId } : {}), idempotencyKey: `e00-${a.task.id}-claims` }) as Any[];
        return { output: { proposed: proposals.length, droppedUnquotable: dropped, proposals: proposals.map((p) => p.ref), usage: usage(answer) } as Json,
          summary: `Proposed ${proposals.length} claim(s) from ${evidenceRef} for human review; ${dropped} dropped because the quotation was not found in the source.`, refs: [evidenceRef, ...proposals.map((p) => String(p.ref))] };
      },
    },
    'agent.propose_questions': {
      description: 'Suggest further research questions for an investigation from its scope and original account; stored as proposals (input: investigationId).',
      requires: ['investigation:read', 'investigation:plan'],
      estimate,
      async run(a) {
        const investigation = runtime.get('investigation'); const id = str(a.task.input, 'investigationId');
        const record = await investigation.getInvestigation(a.ctx, id) as Any; const data = (record.data ?? record) as Any;
        const existing = typeof investigation.listQuestions === 'function' ? ((await investigation.listQuestions(a.ctx, id)) as Any[]).map((q) => String((q.data ?? q).text ?? '')).filter(Boolean) : [];
        const answer = await askOnce(a, model, {
          instruction: [
            'Suggest research questions that a careful investigation of the account below would still need to answer. Each question must be answerable by evidence (documents, records, or asking an identified person), must not presume the account is true, and must not duplicate an existing question.',
            'Mark a question "material" only when the investigation could not honestly be closed without addressing it, and say why in one sentence. At most 8 questions.',
          ].join('\n'),
          material: [{ label: 'scope', text: String(data.scopeStatement ?? '') }, { label: 'original account', text: String(data.originalAccount?.summary ?? '') }, { label: 'existing questions', text: existing.join('\n') }],
          schema: obj({ questions: list(obj({ text, material: { type: 'boolean' }, whyMaterial: text })) }),
        });
        const items = ((answer.output as Any).questions as Any[]).slice(0, 8).map((q) => ({ text: String(q.text).trim().slice(0, 1000), material: q.material === true, ...(q.material === true ? { whyMaterial: String(q.whyMaterial).slice(0, 1000) } : {}) })).filter((q) => q.text.endsWith('?'));
        const proposals = items.length === 0 ? [] : await investigation.proposeQuestions(a.ctx, id, { items, rationale: 'Suggested by the language model from the scope and original account; not yet reviewed.', source: `model:${answer.model}`, idempotencyKey: `e00-${a.task.id}-questions` }) as Any[];
        return { output: { proposed: proposals.length, usage: usage(answer) } as Json, summary: `Proposed ${proposals.length} question(s) for review.`, refs: proposals.map((p) => String(p.ref ?? '')).filter((r) => r.startsWith('E08:')) };
      },
    },
    'agent.draft_inquiry': {
      description: 'Draft one short, truthful inquiry to a recorded contact about a research question. Creates a draft only; sending needs a human or an explicit grant (input: planId, contactId, mailboxId, question, background?).',
      requires: ['correspondence:write'],
      estimate,
      async run(a) {
        const input = a.task.input as Any; const question = str(a.task.input, 'question');
        const answer = await askOnce(a, model, {
          instruction: [
            'Draft a short inquiry to a person who may hold information about the research question below. Give a plain subject line, one sentence stating the purpose, and one to three direct questions, each ending with a question mark.',
            'Do not claim any affiliation, title, urgency, legal authority or relationship. Do not accuse anyone. Do not include personal details about third parties. Do not include links.',
          ].join('\n'),
          material: [{ label: 'research question', text: question }, ...(typeof input.background === 'string' ? [{ label: 'background', text: input.background }] : [])],
          schema: obj({ subject: text, purpose: text, questions: list(text) }),
        });
        const out = answer.output as Any;
        const questions = (out.questions as unknown[]).map((q) => String(q).trim()).filter((q) => q.endsWith('?') && !/https?:\/\//i.test(q)).slice(0, 3);
        if (questions.length === 0) throw new DomainError('unavailable', 'The model produced no usable question; a person has to write this inquiry');
        // The engine renders the message itself (disclosure, sender identity, opt-out) and refuses agent-set recipients or bodies.
        const draft = await runtime.get('correspondence').draftInquiry(a.ctx, { planId: str(a.task.input, 'planId'), contactId: str(a.task.input, 'contactId'), mailboxId: str(a.task.input, 'mailboxId'),
          structured: { subject: String(out.subject).replace(/[\r\n]+/g, ' ').slice(0, 150), purpose: String(out.purpose).replace(/https?:\/\/\S+/gi, '').slice(0, 500), questions }, idempotencyKey: `e00-${a.task.id}-draft` }) as Any;
        return { output: { draft: draft.ref ?? draft.id, state: draft.state ?? 'draft', usage: usage(answer) } as Json, summary: 'Drafted an inquiry; it has not been sent.', refs: [String(draft.ref ?? '')].filter((r) => r.startsWith('E03:')) };
      },
    },
    'agent.extract_answers': {
      description: 'Find passages in a received reply that answer the question asked, as verbatim quotations for a reviewer (input: messageId).',
      requires: ['correspondence:read', 'correspondence:write'],
      estimate,
      async run(a) {
        const correspondence = runtime.get('correspondence'); const messageId = str(a.task.input, 'messageId');
        const message = await correspondence.getMessage(a.ctx, messageId) as Any; const body = String(message.bodyText ?? '');
        if (body.trim() === '') return { output: { proposed: 0 } as Json, summary: 'The reply has no text to read.' };
        const answer = await askOnce(a, model, {
          instruction: 'The message below is a reply to an inquiry. Copy out, exactly, each passage in which the writer answers a question, states a fact, refuses, or says they do not know. Copy only the writer\'s own words from this message, not quoted earlier messages. At most 10 passages. If the message is an automatic reply or contains no answer, return an empty list.',
          material: [{ label: 'reply', text: body }],
          schema: obj({ quotes: list(text) }),
        });
        const quotes = [...new Set(((answer.output as Any).quotes as unknown[]).map((q) => String(q).trim()))].filter((q) => q.length >= 3 && body.includes(q)).slice(0, 10);
        const assertions = quotes.length === 0 ? [] : await correspondence.proposeAssertions(a.ctx, messageId, { quotes, idempotencyKey: `e00-${a.task.id}-answers` }) as Any[];
        return { output: { proposed: assertions.length, usage: usage(answer) } as Json, summary: `Proposed ${assertions.length} quoted passage(s) from the reply for verification.`, refs: assertions.map((x) => String(x.ref ?? '')).filter((r) => r.startsWith('E03:')) };
      },
    },
  };
}

/** E09's ModelPort over the deployment's model: proposals for passages, which the editorial engine stores as suggestions. */
export function editorialModelPort(model: ModelPort | null) {
  return {
    async propose(_ctx: unknown, request: Any): Promise<{ proposals: { text: string; targetBlockId?: string; rationale?: string }[]; model?: string }> {
      if (model === null) throw new DomainError('unavailable', 'No language model is configured for this deployment (set ANTHROPIC_API_KEY)');
      const blocks = (request.blocks ?? []) as Any[]; const max = Math.min(Number(request.maxProposals ?? 3), 10);
      const answer = await model.ask({
        instruction: [
          `Suggest up to ${max} revised or new passages for a ${String(request.docType).slice(0, 40)} titled as given, in language "${String(request.language).slice(0, 20)}", in a ${request.mode === 'creative' ? 'creative' : 'plain analytical'} register.`,
          'Each passage in the material carries its id and its basis label (for example verified_fact, attributed_testimony, inference, reconstruction, invention). Never present inference, reconstruction or invention as established fact, never add factual assertions that are not in the passages, and keep attributions.',
          'For a revision give the id of the passage it replaces as targetBlockId; for a new passage give an empty targetBlockId. Give a one-sentence rationale each.',
          `Editor's instruction (written by staff): ${String(request.instruction).slice(0, 2000)}`,
        ].join('\n'),
        material: [{ label: 'title', text: String(request.title ?? '') }, ...blocks.map((b) => ({ label: `passage id=${b.id} type=${b.type} basis=${b.basis}`, text: String(b.text) }))],
        schema: obj({ proposals: list(obj({ text, targetBlockId: text, rationale: text })) }),
      });
      const ids = new Set(blocks.map((b) => String(b.id)));
      const proposals = ((answer.output as Any).proposals as Any[]).slice(0, max).filter((p) => String(p.text).trim() !== '')
        .map((p) => ({ text: String(p.text), ...(ids.has(String(p.targetBlockId)) ? { targetBlockId: String(p.targetBlockId) } : {}), rationale: String(p.rationale).slice(0, 500) }));
      return { proposals, model: answer.model };
    },
  };
}
