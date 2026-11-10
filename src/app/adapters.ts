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
        const claims = ((e.claims ?? []) as any[]); // eslint-disable-line @typescript-eslint/no-explicit-any
        const claim = claims.find((c) => ids.size === 0 || ids.has(idOf(c.ref as string))) ?? claims[0];
        if (claim === undefined) return [];
        const when = String(e.time?.earliest ?? e.time?.latest ?? 'date unknown');
        const coarse = ['day', 'month', 'year', 'decade'].includes(String(e.time?.precision));
        const range = e.time?.earliest && e.time?.latest && String(e.time.earliest).slice(0, 10) !== String(e.time.latest).slice(0, 10);
        return [{ at: range ? `${when.slice(0, 10)} to ${String(e.time.latest).slice(0, 10)}` : coarse ? when.slice(0, 10) : when.slice(0, 20), description: `${String(e.title ?? '')}${e.time?.precision === 'approximate' ? ' (date approximate)' : ''}`, claimRef: claim.ref as string, status: String(e.label ?? 'unknown'),
          sources: [...new Set(claims.flatMap((c) => [...((c.supporting ?? []) as any[]), ...((c.challenging ?? []) as any[])].map((l) => String(l.evidenceRef))))] }]; // eslint-disable-line @typescript-eslint/no-explicit-any
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

// ───────────────────────────── E08 package → E12 builders ─────────────────────────────
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const cite = (s: Any, supports: string): { ref: string; locator?: string; supports: string } => ({ ref: String(s.ref), supports, ...(s.selector === undefined || s.selector === null ? {} : { locator: typeof s.selector === 'string' ? s.selector : JSON.stringify(s.selector) }) });
/**
 * Converts an investigation package (E08) into the input the release builders (E12) accept. Nothing is added: statuses,
 * sources and limitations are carried as recorded. A refuted finding is passed as `disputed` with the refutation stated,
 * because the release vocabulary has no stronger negative status and must not present it as established.
 */
export function toReleasePackage(pkg: { ref: string; content: Json }): Json {
  const c = pkg.content as Any;
  const open = ((c.questionTree ?? []) as Any[]).filter((q) => q.status === 'open' || q.status === 'in_progress');
  return {
    investigationRef: pkg.ref, title: String(c.investigation?.title ?? 'Investigation'), summary: String(c.investigation?.scopeStatement ?? ''),
    methodology: `Attempts recorded: ${Array.isArray(c.attempts?.entries) ? c.attempts.entries.length : (c.attempts?.total ?? 'see investigation package')}. Source: ${pkg.ref}.`,
    limitations: (c.limitations ?? []) as string[],
    findings: ((c.findings ?? []) as Any[]).map((f) => ({ id: String(f.id), ref: String(f.ref), statement: f.classification === 'refuted' ? `Refuted: ${f.statement}` : String(f.statement), status: f.classification === 'established' ? 'established' : f.classification === 'unknown' ? 'unknown' : 'disputed',
      sources: [...((f.supporting ?? []) as Any[]).map((s) => cite(s, 'supports')), ...((f.contradicting ?? []) as Any[]).map((s) => cite(s, 'contradicts'))],
      limitations: [...((f.limitations ?? []) as string[]), ...(f.stale === true ? ['This finding is stale after an upstream change and awaits renewed review.'] : [])] })),
    chronology: ((c.chronology?.entries ?? []) as Any[]).map((e) => ({ date: String(e.at), event: String(e.description), status: e.label === 'established' ? 'established' : e.label === 'disputed' ? 'disputed' : 'unknown', sources: ((e.sources ?? []) as string[]).map((ref) => ({ ref })) })),
    openQuestions: open.map((q) => ({ id: String(q.id), question: String(q.text) })),
  } as unknown as Json;
}
/** Evidence index entries (E08 package) → evidence bundle items (E12). Originals are never included by this mapping. */
export function toEvidenceItems(pkg: { content: Json }): Json {
  return (((pkg.content as Any).evidenceIndex ?? []) as Any[]).filter((e) => typeof e.ref === 'string').map((e) => ({ ref: e.ref as string, label: String(e.filename ?? e.ref), description: `sha256 ${String(e.sha256 ?? 'unknown')}; ${String(e.custodySummary ?? 'custody not reported')}`, basis: e.available === false ? 'original unavailable (provenance gap)' : 'preserved original' })) as unknown as Json;
}

// ───────────────────────────── E08 → E04 ─────────────────────────────
export function investigationDiscoveryPort(get: Get) {
  const itemOf = (i: Any) => ({ ref: String(i.ref), title: String(i.title ?? i.url ?? i.ref), ...(i.sourceId ? { sourceId: String(i.sourceId) } : {}), ...(i.evidenceRef ? { evidenceRef: String(i.evidenceRef) } : {}), ...(i.url ? { locator: String(i.url) } : {}) });
  return {
    async startCollectionRun(ctx: ServiceContext, input: { subject: string; objective: string; query: string; sourceIds?: readonly string[]; idempotencyKey: string }) {
      const sourceId = input.sourceIds?.[0];
      if (sourceId === undefined) throw new DomainError('invalid_input', 'A configured source is required to start a collection run');
      const run = await get('discovery').startCollection(ctx, { sourceId, level: 'bytes', questionRef: input.subject, extractLeads: true, idempotencyKey: input.idempotencyKey }) as Any;
      return { runRef: String(run.ref), state: String(run.state) };
    },
    async searchSource(ctx: ServiceContext, input: { query: string; sourceId?: string; limit?: number }) {
      if (input.sourceId === undefined) return { items: [], searched: [], restricted: [] };
      const attempt = await get('discovery').searchSource(ctx, { sourceId: input.sourceId, query: input.query }) as Any;
      const items = ((attempt.items ?? attempt.results ?? []) as Any[]).slice(0, input.limit ?? 50).map(itemOf);
      return { items, searched: [input.sourceId], restricted: attempt.outcome === 'access_restricted' ? [input.sourceId] : [] };
    },
    async getCoverage(ctx: ServiceContext, runRef: string) {
      const discovery = get('discovery'); const runId = idOf(runRef);
      const run = await discovery.getRun(ctx, runId) as Any; const cov = await discovery.coverage(ctx, { runId }) as Any;
      const page = await discovery.listItems(ctx, { runId, limit: 200 }) as Any; const items = (Array.isArray(page) ? page : (page.items ?? [])) as Any[];
      const leadPage = await discovery.listLeads(ctx, { limit: 200 }).catch(() => []) as Any; const leads = (Array.isArray(leadPage) ? leadPage : (leadPage.items ?? [])) as Any[];
      const state = ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(run.state) ? run.state : run.state === 'paused' ? 'queued' : 'running';
      const total = Number(cov.acquiredBytes ?? 0) + Number(cov.acquiredMetadata ?? 0) + Number(cov.linkOnly ?? 0);
      return { runRef, state, items: items.map(itemOf), contactLeads: leads.map((l) => ({ ref: String(l.ref), label: String(l.role ?? l.organization ?? 'contact lead') })),
        sources: [{ sourceId: String(run.sourceId), status: Number(cov.accessRestricted ?? 0) > 0 && total === 0 ? 'access_restricted' : Number(cov.failed ?? 0) > 0 && total === 0 ? 'failed' : total === 0 ? 'zero_result' : 'searched', itemCount: Number(cov.discovered ?? items.length),
          note: `acquired bytes ${cov.acquiredBytes ?? 0}, metadata ${cov.acquiredMetadata ?? 0}, links only ${cov.linkOnly ?? 0}, failed ${cov.failed ?? 0}, restricted ${cov.accessRestricted ?? 0}, gaps open ${cov.gaps?.open ?? 0}` }] };
    },
  };
}

// ───────────────────────────── E09 → E07 ─────────────────────────────
export function editorialKnowledgePort(get: Get) {
  return {
    async getClaimStatus(ctx: ServiceContext, claimRef: string): Promise<{ factual: string; editorial: string; stale: boolean; blocked: boolean } | null> {
      try {
        const claim = await get('knowledge').getClaim(ctx, idOf(claimRef)) as Any;
        return { factual: String(claim.assessments?.factual?.value ?? 'unassessed'), editorial: String(claim.assessments?.editorial?.value ?? 'unassessed'), stale: claim.stale === true, blocked: claim.blocked === true };
      } catch (error) { if (error instanceof DomainError && error.code === 'not_found') return null; throw error; }
    },
  };
}
