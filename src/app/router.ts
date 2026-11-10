// Event router: reads every engine's outbox feed and delivers upstream changes to the engines that hold dependents.
// Delivery is at-least-once; every engine's applyUpstreamChange is idempotent by eventId. A cursor only advances after
// all deliveries for an event were attempted; a failed delivery is retried on the next pass and never dropped silently.
import type { EngineEvent, ServiceContext, UpstreamChange } from '../service-kit.ts';
import { parseUref } from '../service-kit.ts';
import type { Runtime } from './compose.ts';

type Rule = Readonly<{ match: RegExp; kind: UpstreamChange['kind']; to: readonly string[]; refs?: (e: EngineEvent) => string[] }>;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
const payload = (e: EngineEvent): Record<string, unknown> => (e.payload !== null && typeof e.payload === 'object' && !Array.isArray(e.payload) ? e.payload as Record<string, unknown> : {});
const valid = (refs: string[]): string[] => [...new Set(refs)].filter((r) => { try { parseUref(r); return true; } catch { return false; } });
const DOWN_FROM_SOURCE = ['processing', 'knowledge', 'investigation', 'editorial', 'production', 'release', 'correspondence'];
const DOWN_FROM_CLAIM = ['investigation', 'editorial', 'production', 'release'];
const ALL_USERS = ['evidence', 'processing', 'knowledge', 'investigation', 'correspondence', 'discovery', 'editorial', 'production', 'release', 'resources'];

/** Which engines learn about which events. Order follows the dependency chain in docs/ENGINE_SERVICE_CONVENTION.md §2. */
export const RULES: readonly Rule[] = [
  { match: /^evidence\.version_added$/, kind: 'source_superseded', to: DOWN_FROM_SOURCE, refs: (e) => [...strings(payload(e).previous), e.subject.split('@')[0] as string] },
  { match: /^evidence\.(stale|integrity_failed)$/, kind: 'source_corrected', to: DOWN_FROM_SOURCE },
  { match: /^evidence\.(blocked|restricted)$/, kind: 'rights_changed', to: DOWN_FROM_SOURCE },
  { match: /^processing\.text_corrected$/, kind: 'source_corrected', to: ['knowledge', 'investigation', 'editorial', 'production', 'release'], refs: (e) => [e.subject, ...strings(payload(e).previousRef), ...strings(payload(e).representationRef), ...strings(payload(e).stale)] },
  { match: /^processing\..*(stale|blocked)$/, kind: 'source_corrected', to: ['knowledge', 'investigation', 'editorial', 'production', 'release'] },
  { match: /^knowledge\.claim_(stale|changed)$/, kind: 'claim_changed', to: DOWN_FROM_CLAIM, refs: (e) => [e.subject, ...strings(payload(e).claims), ...strings(payload(e).affected)] },
  { match: /^knowledge\.claim_blocked$/, kind: 'rights_changed', to: DOWN_FROM_CLAIM, refs: (e) => [e.subject, ...strings(payload(e).claims), ...strings(payload(e).affected)] },
  { match: /^investigation\.(finding|package)_stale$/, kind: 'claim_changed', to: ['editorial', 'production', 'release'], refs: (e) => [e.subject, ...strings(payload(e).affected)] },
  { match: /^editorial\.(document_revised|block_stale|approval_invalidated)$/, kind: 'content_changed', to: ['production', 'release'], refs: (e) => [e.subject, e.subject.split('@')[0] as string, ...strings(payload(e).document), ...strings(payload(e).affected)] },
  { match: /^editorial\.block_blocked$/, kind: 'rights_changed', to: ['production', 'release'], refs: (e) => [e.subject, ...strings(payload(e).document), ...strings(payload(e).affected)] },
  { match: /^production\.render_(stale|blocked|completed)$/, kind: 'render_changed', to: ['release'], refs: (e) => [e.subject, e.subject.split('@')[0] as string, ...strings(payload(e).project), ...strings(payload(e).supersedes)] },
  { match: /^consent\.permission_withdrawn$/, kind: 'permission_withdrawn', to: ALL_USERS, refs: (e) => [e.subject, ...strings(payload(e).subjects), ...strings(payload(e).affectedOutputs)] },
  { match: /^consent\.permission_(changed|expired)$/, kind: 'permission_changed', to: ALL_USERS, refs: (e) => [e.subject, ...strings(payload(e).subjects)] },
];

/**
 * Reactions: events that create follow-up work in another engine (as opposed to marking dependents stale).
 * A reply's assertions go to the knowledge engine as PROPOSALS from origin `reply`, typed as unverified allegations whose
 * origin names the preserved message (the knowledge engine reserves `attributed_statement` for claims tied to a statement
 * record that a human reviewer creates). They await human review and are never verified facts. Idempotent by the event id.
 */
type Reaction = Readonly<{ match: RegExp; run: (runtime: Runtime, ctx: ServiceContext, e: EngineEvent, eventKey: string) => Promise<void> }>;
export const REACTIONS: readonly Reaction[] = [
  { match: /^correspondence\.reply_received$/, run: async (runtime, ctx, e, eventKey) => {
    const knowledge = runtime.maybe('knowledge'); if (knowledge === null) return;
    const p = payload(e); const candidates = (Array.isArray(p.candidates) ? p.candidates : []) as { text?: unknown }[];
    const items = candidates.filter((c) => typeof c.text === 'string' && c.text.trim().length >= 12).slice(0, 20).map((c) => ({ text: (c.text as string).trim().slice(0, 2000), claimType: 'allegation', ...(typeof p.questionRef === 'string' ? { question: p.questionRef } : {}) }));
    if (items.length === 0) return;
    await knowledge.proposeClaims(ctx, { origin: { kind: 'reply', ref: e.subject, label: 'Reply received by correspondence; attributed, not verified' }, items, idempotencyKey: `reply-${eventKey}` });
  } },
];

export type RouterReport = { events: number; deliveries: number; failures: { engine: string; eventId: string; error: string }[] };

export async function routeEventsOnce(runtime: Runtime, options: { batch?: number } = {}): Promise<RouterReport> {
  const report: RouterReport = { events: 0, deliveries: 0, failures: [] };
  const tenants = await runtime.sql.query<{ tenant_id: string; home_project_id: string }>('select tenant_id, home_project_id from pam_app.tenants');
  for (const [short, entry] of runtime.engines) {
    if (entry.engine === null) continue;
    for (const { tenant_id: tenantId, home_project_id: homeProject } of tenants) {
      const cursorKey = `${short}:${tenantId}`;
      const after = await runtime.orchestration.routerCursor(cursorKey);
      let events: EngineEvent[];
      try {
        // Feeds are tenant-wide; the service reads them from the organization's home project scope.
        events = await entry.engine.events(await runtime.serviceContext({ tenantId, projectId: homeProject }), { after, limit: options.batch ?? 200 });
      } catch (error) { report.failures.push({ engine: short, eventId: '-', error: `feed: ${error instanceof Error ? error.message : String(error)}` }); continue; }
      for (const event of events) {
        report.events++;
        const rule = RULES.find((r) => r.match.test(event.type));
        let ok = true;
        if (rule !== undefined) {
          const refs = valid(rule.refs === undefined ? [event.subject] : rule.refs(event));
          const change: UpstreamChange = { eventId: `${entry.id}:${event.id}`, kind: rule.kind, refs, reason: `${event.type} (${event.subject})` };
          const ctx = await runtime.serviceContext({ tenantId: event.tenantId, projectId: event.projectId });
          const targets = [...rule.to.filter((t) => t !== short), 'orchestration'];
          for (const target of targets) {
            const engine = target === 'orchestration' ? runtime.orchestration : runtime.maybe(target);
            if (engine === null || refs.length === 0) continue;
            try { await engine.applyUpstreamChange(ctx, change); report.deliveries++; }
            catch (error) { ok = false; report.failures.push({ engine: target, eventId: change.eventId, error: error instanceof Error ? error.message : String(error) }); }
          }
        }
        for (const reaction of REACTIONS) {
          if (!reaction.match.test(event.type)) continue;
          try { await reaction.run(runtime, await runtime.serviceContext({ tenantId: event.tenantId, projectId: event.projectId }), event, `${entry.id}:${event.id}`); report.deliveries++; }
          catch (error) { ok = false; report.failures.push({ engine: 'reaction', eventId: `${entry.id}:${event.id}`, error: error instanceof Error ? error.message : String(error) }); }
        }
        if (!ok) break; // retry this event (and everything after it) on the next pass
        await runtime.orchestration.advanceRouterCursor(cursorKey, event.id);
      }
    }
  }
  return report;
}
