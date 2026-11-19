// Acceptance test G: research record standard (docs/RESEARCH_RECORD_STANDARD.md) on the composed application over HTTP.
// A script that writes without a research run is refused and the refusal is journalled; the web application's writes are
// journalled; a tool is registered by its exact source, a run is started, the script's write carries the run, the run is
// finished with its output and lands in the project's research log; a finished run cannot be reused or finished again;
// journal and tool rows cannot be changed or deleted in the database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { REQUIRED, skipReason, withStack } from './harness.ts';
import { startServer } from '../../src/app/server.ts';

const skip = skipReason(REQUIRED);

test('G: research record — tools, runs, journal, enforcement and append-only storage', { skip, timeout: 300_000 }, async () => {
  await withStack(async (stack) => {
    const org = await stack.createOrg('Research record org');
    const server = await startServer(stack.runtime, { port: 0, worker: false });
    try {
      const identity = stack.runtime.get('identity');
      const token = async (purpose: string): Promise<string> => (await identity.issueAccessToken({ refreshToken: org.owner.refreshToken, tenantId: org.tenantId, projectId: org.projectId, purpose }) as { token: string }).token;
      const research = await token('research');
      const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; bearer?: string } = {}) => {
        const res = await fetch(`${server.url}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers: { authorization: `Bearer ${init.bearer ?? research}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
        return { status: res.status, json: await res.json().catch(() => null) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      };
      const upload = (text: string) => ({ contentBase64: Buffer.from(text).toString('base64'), mediaType: 'text/plain', filename: 'note.txt' });

      // 1. A script's write without a run is refused, and the refusal is journalled.
      const refused = await call('/api/e/evidence/v1/evidence/accept', { body: upload('script write without a run') });
      assert.equal(refused.status, 428); assert.equal(refused.json.error.code, 'research_run_required');
      // 2. The application's own write is accepted and journalled as the application's.
      const fromApp = await call('/api/e/evidence/v1/evidence/accept', { body: upload('written in the application'), headers: { 'x-pam-client': 'pam-web' } });
      assert.equal(fromApp.status, 201);
      // 3. Account security is not research: no run needed.
      const enroll = await call('/api/e/identity/v1/mfa/enroll', { body: {}, bearer: await token('workspace') });
      assert.notEqual(enroll.status, 428);

      // 4. Tools are registered by their exact source; runs need registered tools.
      const source = 'print("fictional scraper v1")\n';
      const tool = await call('/api/app/v1/research/tools', { body: { name: 'fictional-scraper', version: '1', description: 'Captures a fictional list page', filename: 'scraper.py', contentBase64: Buffer.from(source).toString('base64') } });
      assert.equal(tool.status, 201, JSON.stringify(tool.json));
      assert.equal(tool.json.sha256, createHash('sha256').update(source).digest('hex'));
      assert.match(tool.json.evidenceRef, /^E05:evidence_version:/);
      const again = await call('/api/app/v1/research/tools', { body: { name: 'fictional-scraper', version: '1', description: 'Captures a fictional list page', filename: 'scraper.py', contentBase64: Buffer.from(source).toString('base64') } });
      assert.equal(again.json.created, false);
      const unknown = await call('/api/app/v1/research/runs', { body: { purpose: 'x', tools: ['0'.repeat(64)], command: 'python3 scraper.py' } });
      assert.equal(unknown.status, 400);

      // 5. A run: the script's write carries it; finishing preserves the output and writes the research log.
      const run = await call('/api/app/v1/research/runs', { body: { purpose: 'Capture the fictional list', tools: [tool.json.sha256], command: 'python3 scraper.py --page 1', environment: { python: '3.13' } } });
      assert.equal(run.status, 201, JSON.stringify(run.json));
      assert.ok(run.json.logInvestigationId, 'the research log is opened with the first run');
      const inRun = await call('/api/e/evidence/v1/evidence/accept', { body: upload('captured page'), headers: { 'x-pam-run': run.json.id } });
      assert.equal(inRun.status, 201);
      const finished = await call(`/api/app/v1/research/runs/${run.json.id}/finish`, { body: { exitCode: 0, summary: 'Captured 1 page.', kind: 'acquisition', outputBase64: Buffer.from('1 page captured\n').toString('base64'), refs: [inRun.json.ref] } });
      assert.equal(finished.status, 200, JSON.stringify(finished.json));
      assert.equal(finished.json.outcome, 'succeeded'); assert.match(finished.json.outputRef, /^E05:/); assert.ok(finished.json.logAttemptId); assert.equal(finished.json.logError, null);
      const attempts = await stack.runtime.get('investigation').listAttempts(await org.as(org.owner, 'research'), run.json.logInvestigationId) as { id: string; detail: string; refs: string[]; kind: string }[];
      const entry = attempts.find((a) => a.id === finished.json.logAttemptId);
      assert.ok(entry); assert.equal(entry.kind, 'acquisition');
      assert.match(entry.detail, new RegExp(tool.json.sha256)); assert.match(entry.detail, /python3 scraper\.py --page 1/);
      assert.ok(entry.refs.includes(finished.json.outputRef) && entry.refs.includes(tool.json.evidenceRef));

      // 5b. A run whose account exceeds a log entry's 4,000 characters is preserved whole in evidence and linked.
      const long = await call('/api/app/v1/research/runs', { body: { purpose: 'Long command', tools: [tool.json.sha256], command: `python3 scraper.py ${'--page 1 '.repeat(800)}` } });
      const longDone = await call(`/api/app/v1/research/runs/${long.json.id}/finish`, { body: { exitCode: 0, summary: 'Long run.' } });
      assert.equal(longDone.json.logError, null); assert.ok(longDone.json.logAttemptId);
      const longEntry = (await stack.runtime.get('investigation').listAttempts(await org.as(org.owner, 'research'), run.json.logInvestigationId) as { id: string; detail: string; refs: string[] }[]).find((a) => a.id === longDone.json.logAttemptId)!;
      assert.ok(longEntry.detail.length <= 4000); assert.match(longEntry.detail, /complete record of this run/); assert.match(longEntry.refs[0] as string, /^E05:/);

      // 6. A finished run cannot carry writes or be finished again.
      assert.equal((await call('/api/e/evidence/v1/evidence/accept', { body: upload('late write'), headers: { 'x-pam-run': run.json.id } })).status, 409);
      assert.equal((await call(`/api/app/v1/research/runs/${run.json.id}/finish`, { body: { exitCode: 0, summary: 'again' } })).status, 409);

      // 7. The record: the run's write is linked to it; nothing went through outside a run.
      await new Promise((r) => setTimeout(r, 200)); // journal rows are written when each response finishes
      const record = await call('/api/app/v1/research/record');
      assert.equal(record.status, 200);
      assert.equal(record.json.counts.writesOutsideRuns, 0);
      assert.ok(record.json.journal.some((w: { status: number; run_id: string | null }) => w.status === 428 && w.run_id === null));
      assert.ok(record.json.journal.some((w: { client: string | null; status: number }) => w.client === 'pam-web' && w.status === 201));
      const detail = await call(`/api/app/v1/research/runs/${run.json.id}`);
      assert.equal(detail.json.writes.length, 2); // the accepted write and the refused late write
      assert.deepEqual(detail.json.writes.map((w: { status: number }) => w.status).sort(), [201, 409]);

      // 8. Append-only in the database itself.
      await assert.rejects(stack.runtime.sql.query(`update pam_app.research_journal set status=200`), /append-only/);
      await assert.rejects(stack.runtime.sql.query(`delete from pam_app.research_tools`), /append-only/);
      await assert.rejects(stack.runtime.sql.query(`update pam_app.research_runs set purpose='rewritten'`), /append-only/);
    } finally { await server.stop(); }
  });
});
