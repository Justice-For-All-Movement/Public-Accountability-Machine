// Port adapters: the shapes one engine expects from a collaborator, implemented over another engine's real service
// interface. No engine imports another; this file is the only place their vocabularies meet.
import { DomainError } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { parseUref } from '../service-kit.ts';
import type { ServiceContext } from '../service-kit.ts';
import type { AnyEngine } from './compose.ts';

type Get = (short: string) => AnyEngine;
const idOf = (ref: string): string => parseUref(ref).id;
const LABEL_TO_CLAIM_TYPE: Record<string, string> = { allegation: 'allegation', attributed_testimony: 'attributed_statement', verified_fact: 'observation', inference: 'inference', unknown: 'allegation' };

/** E08 → E05: describe plus origin and custody for the evidence index. */
export function investigationEvidencePort(get: Get) {
  return {
    describe: (ctx: ServiceContext, ref: string) => get('evidence').describe(ctx, ref),
    async describeProvenance(ctx: ServiceContext, ref: string): Promise<{ origin: Json; custodySummary: string; custodyEvents: number } | null> {
      const evidence = get('evidence');
      const info = await evidence.describe(ctx, ref);
      if (info === null) return null;
      const provenance = await evidence.provenance(ctx, ref) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const custody = await evidence.custody(ctx, ref) as { entries: { action?: string; at?: string }[]; chainValid: boolean };
      const first = custody.entries[0], last = custody.entries.at(-1);
      return { origin: (provenance.acquisition?.origin ?? provenance.origin ?? null) as Json, custodyEvents: custody.entries.length,
        custodySummary: `${custody.entries.length} custody event(s)${first?.at ? ` from ${first.at}` : ''}${last?.at && last !== first ? ` to ${last.at}` : ''}; chain ${custody.chainValid ? 'verified' : 'NOT verified'}${Array.isArray(provenance.gaps) && provenance.gaps.length > 0 ? `; ${provenance.gaps.length} provenance gap(s) recorded` : ''}` };
    },
  };
}

/** E08 → E06. */
export function investigationProcessingPort(get: Get) {
  const latestText = async (ctx: ServiceContext, evidenceRef: string) => {
    const processing = get('processing');
    const runs = await processing.listProcessing(ctx, { evidenceRef, limit: 5 }) as { id: string; state: string; failure: string | null; blocked: boolean }[];
    const run = runs.find((r) => r.state === 'done' || r.state === 'partial') ?? runs[0];
    if (run === undefined) return { run: null, reps: [] as any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const alignment = await processing.getAlignment(ctx, run.id) as { representations: any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
    return { run, reps: alignment.representations.filter((r) => !r.blocked) };
  };
  return {
    async requestProcessing(ctx: ServiceContext, input: { evidenceRef: string; operations: readonly string[]; idempotencyKey: string }) {
      const view = await get('processing').requestProcessing(ctx, { evidenceRef: input.evidenceRef, idempotencyKey: input.idempotencyKey }) as { ref: string; state: string };
      return { jobRef: view.ref, state: view.state };
    },
    async getText(ctx: ServiceContext, evidenceRef: string) {
      const { run, reps } = await latestText(ctx, evidenceRef);
      if (run === null) return { available: false, reason: 'not processed' };
      const rep = reps.find((r) => r.kind === 'text' || r.kind === 'transcript') ?? reps[0];
      if (rep === undefined) return { available: false, reason: run.state === 'failed' ? `processing failed: ${run.failure ?? 'unknown'}` : `processing ${run.state}` };
      const segments = (rep.segments as any[]).map((s) => ({ text: s.text as string, selector: { representation: rep.ref, segmentId: s.id, ...(s.page === null ? {} : { page: s.page, bbox: s.bbox }), ...(s.startMs === null ? {} : { startMs: s.startMs, endMs: s.endMs }) } as Json })); // eslint-disable-line @typescript-eslint/no-explicit-any
      return { available: true, derivativeRef: rep.ref as string, text: segments.map((s) => s.text).join('\n'), segments };
    },
    async search(ctx: ServiceContext, input: { query: string; evidenceRefs?: readonly string[]; limit?: number }) {
      const hits = await get('processing').searchSegments(ctx, { q: input.query, limit: input.limit ?? 20 }) as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      return { hits: hits.filter((h) => input.evidenceRefs === undefined || input.evidenceRefs.includes(h.evidenceRef)).map((h) => ({ evidenceRef: h.evidenceRef as string, snippet: h.snippet as string, selector: { representation: h.representationRef, segmentId: h.segmentId, ...(h.page === null ? {} : { page: h.page, bbox: h.bbox }), ...(h.startMs === null ? {} : { startMs: h.startMs, endMs: h.endMs }) } as Json })) };
    },
  };
}

/** E08 → E07. Agents can only propose; a human reviewer accepts in the knowledge workspace. */
export function investigationKnowledgePort(get: Get) {
  const claimIds = (refs: readonly string[]): string[] => refs.filter((r) => r.startsWith('E07:claim:')).map(idOf);
  return {
    async proposeClaim(ctx: ServiceContext, input: { subject: string; statement: string; label: string; sources: readonly { ref: string; selector?: Json }[]; idempotencyKey: string }) {
      const knowledge = get('knowledge');
      const evidence = input.sources.filter((s) => s.ref.startsWith('E05:evidence_version:') && s.ref.includes('@')).map((s) => ({ evidenceRef: s.ref, selector: (s.selector ?? { whole: true }) as Json, stance: 'supports' }));
      const item = { text: input.statement, claimType: LABEL_TO_CLAIM_TYPE[input.label] ?? 'allegation', evidence };
      const origin = { kind: 'investigation', ref: input.subject };
      // Humans with write capability create directly; everyone else submits a reviewable proposal.
      if (ctx.actor.kind === 'human' && ctx.capabilities.some((c) => c === 'knowledge:write' || c === 'knowledge:*')) {
        const claim = await knowledge.createClaim(ctx, { text: item.text, claimType: item.claimType, caseId: idOf(input.subject), idempotencyKey: input.idempotencyKey }) as { ref: string; id: string; state: string };
        for (const [i, e] of evidence.entries()) await knowledge.addEvidenceLink(ctx, { target: { kind: 'claim', id: claim.id }, ...e, idempotencyKey: `${input.idempotencyKey}-l${i}` });
        return { claimRef: claim.ref, state: claim.state };
      }
      const [proposal] = await knowledge.proposeClaims(ctx, { origin, items: [item], caseId: idOf(input.subject), idempotencyKey: input.idempotencyKey }) as { ref: string; state: string }[];
      if (proposal === undefined) throw new DomainError('unavailable', 'Claim proposal was not recorded');
      return { claimRef: proposal.ref, state: proposal.state };
    },
    async createLink(_ctx: ServiceContext, _input: { from: string; to: string; relation: string; idempotencyKey: string }): Promise<{ linkRef: string }> {
      throw new DomainError('unavailable', 'Generic links are created in the knowledge workspace as evidence links or relationships');
    },
    async getSourceFamilies(ctx: ServiceContext, refs: readonly string[]) {
      const families = await get('knowledge').list(ctx, 'source_family') as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      return families.filter((f) => (f.members as string[] | undefined)?.some((m) => refs.some((r) => r.split('@')[0] === m.split('@')[0]))).map((f) => ({ familyRef: f.ref as string, label: f.label as string, members: f.members as string[] }));
    },
    async getGaps(ctx: ServiceContext, input: { subject: string; claimRefs: readonly string[] }) {
      const ids = new Set(claimIds(input.claimRefs));
      const gaps = await get('knowledge').researchGaps(ctx, {}) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      const list = (Array.isArray(gaps) ? gaps : (gaps.gaps ?? [])) as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      return list.filter((g) => ids.size === 0 || g.claimId === undefined || ids.has(g.claimId)).map((g, i) => ({ id: String(g.id ?? `${g.kind ?? g.type}-${g.claimId ?? i}`), kind: String(g.kind ?? g.type ?? 'gap'), description: String(g.description ?? g.detail ?? g.message ?? g.kind ?? ''), ...(g.claimRef ? { claimRef: g.claimRef as string } : g.claimId ? { claimRef: `E07:claim:${g.claimId}` } : {}) }));
    },
    async getChronology(ctx: ServiceContext, input: { subject: string; claimRefs: readonly string[] }) {
      const out = await get('knowledge').chronology(ctx, {}) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      const entries = (Array.isArray(out) ? out : (out.entries ?? [])) as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      const ids = new Set(claimIds(input.claimRefs));
      return entries.flatMap((e) => {
        const claims = ((e.claims ?? e.supportingClaims ?? []) as any[]).map((c) => (typeof c === 'string' ? c : (c.ref as string))); // eslint-disable-line @typescript-eslint/no-explicit-any
        const claimRef = claims.find((c) => ids.size === 0 || ids.has(idOf(c))) ?? claims[0];
        if (claimRef === undefined) return [];
        return [{ at: String(e.at ?? e.time?.earliest ?? e.earliest ?? e.label ?? ''), description: String(e.description ?? e.title ?? e.text ?? ''), claimRef, ...(e.status ?? e.label ? { status: String(e.status ?? e.label) } : {}), sources: ((e.sources ?? e.evidence ?? []) as any[]).map((s) => (typeof s === 'string' ? s : String(s.evidenceRef ?? s.ref))) }]; // eslint-disable-line @typescript-eslint/no-explicit-any
      });
    },
    async getGraph(ctx: ServiceContext, input: { claimRefs: readonly string[] }) {
      const nodes: Json[] = [], edges: Json[] = [];
      for (const id of claimIds(input.claimRefs).slice(0, 50)) { const g = await get('knowledge').evidenceGraph(ctx, { claimId: id }) as { nodes: Json[]; edges: Json[] }; nodes.push(...g.nodes); edges.push(...g.edges); }
      return { nodes, edges };
    },
    async getImpact(ctx: ServiceContext, ref: string) {
      const impact = await get('knowledge').impactOf(ctx, [ref]) as { claims: string[]; evidenceLinks: string[]; statements: string[] };
      return { dependents: [...impact.claims, ...impact.evidenceLinks, ...impact.statements] };
    },
  };
}
