// Orchestration actions and PAM application routes. Actions are the only way agents act: each names the capabilities it
// needs and calls engines through their service interfaces under the task's authorized context. Long-running engine work
// is started once (idempotency key derived from the task) and then followed through checkpoints, so a restarted worker
// resumes following the same engine job instead of starting it again.
import { DomainError } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import type { Route } from '../service-kit.ts';
import type { ActionContext, ActionDefinition } from '../orchestration/index.ts';
import type { Runtime } from './compose.ts';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const str = (input: Json, key: string): string => {
  const v = (input as Any)?.[key];
  if (typeof v !== 'string' || v === '') throw new DomainError('invalid_input', `Task input "${key}" is required`);
  return v;
};
/** Waits for an engine-side job by polling `read`, keeping the task lease alive through checkpoints. */
async function follow<T>(a: ActionContext, read: () => Promise<T>, done: (v: T) => boolean, progress: (v: T) => Json, timeoutMs = 30 * 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    await a.saveCheckpoint({ ...((a.checkpoint ?? {}) as Any), progress: progress(v) });
    if (Date.now() > deadline) throw new DomainError('unavailable', 'Engine work did not finish in time; the task will be retried and will resume following it');
    await new Promise((r) => setTimeout(r, 500));
  }
}
const key = (a: ActionContext, suffix = ''): string => `e00-${a.task.id}${suffix}`;

export function loadActions(runtime: Runtime): Record<string, ActionDefinition> {
  return {
    'processing.process_evidence': {
      description: 'Extract text, OCR, transcribe and index one preserved evidence version (input: evidenceRef).',
      requires: ['processing:write', 'processing:read'],
      async run(a) {
        const processing = runtime.get('processing');
        const started = (a.checkpoint as Any)?.processingId as string | undefined
          ?? (await processing.requestProcessing(a.ctx, { evidenceRef: str(a.task.input, 'evidenceRef'), idempotencyKey: key(a) }) as Any).id as string;
        await a.saveCheckpoint({ processingId: started });
        const view = await follow(a, () => processing.getProcessing(a.ctx, started), (v: Any) => ['done', 'partial', 'failed', 'cancelled'].includes(v.state), (v: Any) => ({ state: v.state }));
        if (view.state === 'failed' || view.state === 'cancelled') throw new DomainError('unavailable', `Processing ${view.state}: ${view.failure ?? 'no detail'}`);
        return { output: { processing: view.ref, state: view.state, representations: view.representations }, summary: `Processed ${str(a.task.input, 'evidenceRef')} (${view.state}); ${view.representations.length} representation(s).`, refs: [view.ref, str(a.task.input, 'evidenceRef'), ...view.representations] };
      },
    },
    'discovery.collect': {
      description: 'Run a collection over a configured source and report coverage (input: sourceId, questionRef?, level?).',
      requires: ['discovery:acquire', 'discovery:read'],
      estimate: () => ({ category: 'discovery.collection', amount: 60, unit: 'compute_seconds' }),
      async run(a) {
        const discovery = runtime.get('discovery'); const input = a.task.input as Any;
        const runId = (a.checkpoint as Any)?.runId as string | undefined
          ?? (await discovery.startCollection(a.ctx, { sourceId: str(a.task.input, 'sourceId'), level: input.level ?? 'bytes', ...(input.questionRef ? { questionRef: input.questionRef } : {}), extractLeads: true, idempotencyKey: key(a) }) as Any).id as string;
        await a.saveCheckpoint({ runId });
        const run = await follow(a, () => discovery.getRun(a.ctx, runId), (v: Any) => ['completed', 'failed', 'cancelled'].includes(v.state), (v: Any) => ({ state: v.state }));
        const coverage = await discovery.coverage(a.ctx, { runId }) as Any;
        if (run.state !== 'completed') throw new DomainError('unavailable', `Collection ${run.state}: ${JSON.stringify({ failed: coverage.failed, accessRestricted: coverage.accessRestricted }).slice(0, 300)}`);
        // A run that completed without discovering anything because the source failed is a provider failure, not success.
        if (Number(coverage.discovered ?? 0) === 0 && Number(coverage.acquiredBytes ?? 0) === 0) throw new DomainError('unavailable', `The source yielded nothing: ${JSON.stringify({ pages: coverage.pages, failed: coverage.failed, gaps: coverage.gaps }).slice(0, 300)}`);
        return { output: { run: run.ref, coverage } as Json, summary: `Collected from source: ${coverage.acquiredBytes} original(s), ${coverage.failed} failed, ${coverage.gaps?.open ?? 0} open gap(s).`, refs: [run.ref] };
      },
    },
    'investigation.plan': {
      description: 'Derive the next concrete research steps for an investigation and add them as tasks (input: investigationId).',
      requires: ['investigation:plan', 'investigation:read'],
      async run(a) {
        const investigation = runtime.get('investigation');
        const plan = await investigation.planNextSteps(a.ctx, str(a.task.input, 'investigationId')) as Any;
        const steps = (plan.steps ?? []) as Any[];
        // Agents propose; whether proposals run without a human depends on the objective's server-side policy.
        await a.spawn(steps.slice(0, 20).map((s, i) => ({ key: `${a.task.key}-step-${i + 1}`, title: String(s.title ?? s.action ?? 'research step').slice(0, 200), action: 'investigation.execute_step', input: { stepId: String(s.id) }, dependsOn: [a.task.key] })));
        return { output: { steps: steps.length, waiting: plan.waiting ?? [], notes: plan.notes ?? [] } as Json, summary: `Planned ${steps.length} step(s).`, refs: steps.map((s) => String(s.ref)).filter((r) => r.startsWith('E08:')) };
      },
    },
    'investigation.execute_step': {
      description: 'Execute one planned investigation step through the owning engine (input: stepId).',
      requires: ['investigation:execute', 'investigation:read'],
      async run(a) {
        const investigation = runtime.get('investigation');
        const jobId = (a.checkpoint as Any)?.jobId as string | undefined
          ?? (await investigation.executeStep(a.ctx, str(a.task.input, 'stepId'), { idempotencyKey: key(a) }) as Any).jobId as string;
        await a.saveCheckpoint({ jobId });
        const job = await follow(a, () => investigation.getJob(a.ctx, jobId), (v: Any) => ['done', 'dead', 'cancelled', 'failed'].includes(v.state), (v: Any) => ({ state: v.state }));
        if (job.state !== 'done') throw new DomainError('unavailable', `Step ${job.state}: ${job.lastError ?? ''}`);
        return { output: job.result as Json, summary: `Step ${str(a.task.input, 'stepId')} finished.` };
      },
    },
    'investigation.build_package': {
      description: 'Build a new version of the investigation package (input: investigationId).',
      requires: ['investigation:write', 'investigation:read'],
      async run(a) {
        const pkg = await runtime.get('investigation').buildPackage(a.ctx, str(a.task.input, 'investigationId'), { idempotencyKey: key(a) }) as Any;
        return { output: { package: pkg.ref, digest: pkg.digest }, summary: `Built package version ${pkg.version}.`, refs: [pkg.ref] };
      },
    },
    'knowledge.gaps': {
      description: 'Report research gaps for the project (input: none).',
      requires: ['knowledge:read'],
      async run(a) {
        const gaps = await runtime.get('knowledge').researchGaps(a.ctx, {}) as Any;
        const list = (Array.isArray(gaps) ? gaps : gaps.gaps ?? []) as Any[];
        return { output: { count: list.length, gaps: list.slice(0, 50) } as Json, summary: `${list.length} research gap(s).` };
      },
    },
  };
}
export function loadExtraRoutes(_runtime: Runtime): Route[] { return []; }
