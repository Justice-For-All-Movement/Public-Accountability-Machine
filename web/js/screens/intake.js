// Intake & cases. Intake (E02) is a separate application: this screen links to it and lists the investigations PAM
// opened from intake cases (through the intake bridge).
import { appApi } from '../api.js';
import { h, region, section, table, renderEmpty, ref, badge } from '../ui.js';

export async function render(el, ctx) {
  const links = region('Intake application'); const cases = region('Investigations opened from intake');
  el.append(links.el, cases.el);
  section(cases.body, () => appApi('/v1/intake/links', { purpose: ctx.purpose }), (data, body) => {
    if (data.intakeUrl) {
      const base = data.intakeUrl.replace(/\/$/, '');
      links.body.append(h('ul', {}, h('li', {}, h('a', { href: `${base}/staff`, rel: 'noopener noreferrer', target: '_blank' }, 'Open the intake staff application (new tab)')), h('li', {}, h('a', { href: `${base}/`, rel: 'noopener noreferrer', target: '_blank' }, 'Participant submission form (new tab)'))));
    } else links.body.append(h('p', { class: 'ws-notice ws-notice--warn', text: 'No intake application address is configured for this deployment (PAM_INTAKE_PUBLIC_URL).' }));
    links.body.append(h('p', { text: data.configured ? 'This organization has an intake connection: new cases are preserved as evidence and opened as investigations automatically.' : 'This organization has no intake connection configured, so no cases are imported.' }));
    if (data.links.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No intake cases yet', 'Investigations opened from intake cases will be listed here.'); return; }
    table(body, { caption: `Linked intake records (${data.links.length})`, rows: data.links, rowHeader: 'title', columns: [
      { key: 'title', label: 'Investigation', render: (r) => h('a', { href: `/investigations?id=${r.investigationId}`, 'data-nav': true }, r.title) },
      { key: 'state', label: 'State', render: (r) => badge('ok', { label: r.state }) }, { key: 'intakeKind', label: 'Intake record kind' }, { key: 'intakeId', label: 'Intake id' }, { key: 'ref', label: 'Reference', render: (r) => ref(r.ref) }, { key: 'linkedAt', label: 'Linked' }] });
  });
}
