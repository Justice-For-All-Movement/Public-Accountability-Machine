// Inspector drawer: linked graph (sources and dependents), object inspector and controls for any universal reference.
import { GraphView, InspectorPanel, ControlBar } from '/engines/workspace/web/index.js';
import { api, availablePurposes } from './api.js';
import { h, clear, renderError, announce, uid } from './ui.js';

export function createInspector({ drawer, body, title, close, purpose }) {
  let current = null; let returnFocus = null; let actingPurpose = null; let handles = [];
  const destroy = () => { for (const x of handles) x.destroy(); handles = []; };

  function hide(restore = true) {
    if (drawer.hidden) return;
    drawer.hidden = true; destroy(); clear(body); current = null;
    document.body.classList.remove('pam-inspecting');
    if (restore && returnFocus && document.contains(returnFocus)) returnFocus.focus();
  }
  close.addEventListener('click', () => hide());
  drawer.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('.ws-dialog')) { event.preventDefault(); hide(); } });

  async function load(ref) {
    destroy(); clear(body);
    const p = actingPurpose ?? purpose();
    const purposes = [...new Set([p, ...availablePurposes()])];
    const selId = uid('pam-insp-purpose');
    const select = h('select', { id: selId }, purposes.map((x) => h('option', { value: x, selected: x === p ? true : undefined }, x)));
    select.addEventListener('change', () => { actingPurpose = select.value; void load(ref); });
    const refLine = h('p', { class: 'pam-inspector__ref' }, h('span', { class: 'ws-muted', text: 'Reference: ' }), h('code', { text: ref }));
    const graphEl = h('section', { class: 'pam-inspector__graph', 'aria-label': 'Linked objects' });
    const controlsEl = h('section', { class: 'pam-inspector__controls', 'aria-label': 'Controls' });
    const panelEl = h('section', { class: 'pam-inspector__panel', 'aria-label': 'Object details' });
    body.append(refLine, h('div', { class: 'pam-field pam-field--inline' }, h('label', { for: selId, text: 'Acting with purpose' }), select), h('h3', { text: 'Controls' }), controlsEl, h('h3', { text: 'Details' }), panelEl, h('h3', { text: 'Linked objects' }), graphEl);
    const panelHolder = h('div', {}); panelEl.append(panelHolder);
    const panel = InspectorPanel(panelHolder, { object: null, state: 'loading', headingLevel: 4, onNavigate: open }); handles.push(panel);
    const q = { ref };
    const [object, linked, controls] = await Promise.allSettled([
      api('workspace', '/v1/objects', { purpose: p, query: q }),
      api('workspace', '/v1/linked', { purpose: p, query: { ref, depth: 2 } }),
      api('workspace', '/v1/controls', { purpose: p, query: q }),
    ]);
    if (current !== ref) return;
    if (object.status === 'fulfilled') { panel.update({ object: object.value, state: 'ready' }); title.textContent = `Inspector: ${object.value.title || ref}`; }
    else { const e = object.reason; panel.update({ state: e?.panelState === 'denied' || e?.status === 404 ? 'denied' : e?.panelState ?? 'error', error: { code: e?.code, message: e?.message, requestId: e?.requestId ?? undefined }, onRetry: () => load(ref) }); title.textContent = 'Inspector'; }
    if (linked.status === 'fulfilled') {
      const holder = h('div', {}); graphEl.append(holder);
      handles.push(GraphView(holder, { graph: linked.value, table: linked.value.table, outline: linked.value.outline, selected: linked.value.root, label: `Sources and dependents of ${ref}`, onSelect: open, onNavigate: open }));
      graphEl.append(h('p', { class: 'ws-muted', text: `Snapshot generated ${linked.value.generatedAt ?? ''}.` }));
    } else renderError(graphEl, linked.reason, () => load(ref));
    if (controls.status === 'fulfilled') {
      const holder = h('div', {}); controlsEl.append(holder);
      if ((controls.value.controls ?? []).length === 0) holder.append(h('p', { class: 'ws-muted', text: 'No controls are offered for this object.' }));
      else handles.push(ControlBar(holder, { ref, controls: controls.value.controls, label: 'Controls for this object', onInvoke: async (r, controlId, input, { confirm }) => {
        const out = await api('workspace', '/v1/controls/invoke', { purpose: p, body: { ref: r, controlId, input, confirm } });
        announce(`Control ${controlId}: ${out.outcome ?? 'answered'}.`);
        return out;
      } }));
    } else renderError(controlsEl, controls.reason, () => load(ref));
  }

  function open(ref) {
    if (drawer.hidden) returnFocus = document.activeElement;
    current = ref;
    drawer.hidden = false;
    document.body.classList.add('pam-inspecting');
    title.textContent = 'Inspector';
    title.focus();
    void load(ref).catch((error) => renderError(body, error, () => load(ref)));
  }
  return { open, close: hide };
}
