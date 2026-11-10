// Global search across engines (workspace searchAll).
import { SearchResults } from '/engines/workspace/web/index.js';
import { api } from '../api.js';
import { h, openInspector, form } from '../ui.js';

export async function render(el, ctx) {
  const q = ctx.params.get('q') ?? '';
  el.append(form({ legend: 'Search', submit: 'Search', resetOnSuccess: false, fields: [{ name: 'q', label: 'Words to find', required: true, value: q }], onSubmit: async (v) => { ctx.navigate(`/search?q=${encodeURIComponent(v.q)}`); return 'Searching.'; } }));
  const holder = h('div', {}); el.append(holder);
  const view = SearchResults(holder, { result: null, state: q ? 'loading' : 'empty', headingLevel: 2, onNavigate: openInspector });
  if (!q) return;
  const run = async () => {
    view.update({ state: 'loading' });
    try { view.update({ result: await api('workspace', '/v1/search-all', { purpose: ctx.purpose, query: { q, limit: 20 } }), state: 'ready' }); }
    catch (e) { view.update({ state: e.panelState ?? 'error', error: { code: e.code, message: e.message, requestId: e.requestId ?? undefined, engines: e.engine ? [e.engine] : undefined }, onRetry: run }); }
  };
  await run();
}
