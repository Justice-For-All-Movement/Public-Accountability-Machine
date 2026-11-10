// Screen registry. Each screen module exports render(container, ctx). Modules load on first use.
import { h } from '../ui.js';

const lazy = (loader) => async (el, ctx) => (await loader()).render(el, ctx);
const notBuilt = (what) => async (el) => { el.append(h('div', { class: 'pam-state', dataset: { state: 'not-built' } }, h('p', { class: 'ws-notice ws-notice--warn', text: `This screen is not yet built in this version of the application. ${what}` }))); };

export const SCREENS = [
  { id: 'overview', title: 'Overview', purpose: 'workspace', render: lazy(() => import('./overview.js')) },
  { id: 'objectives', title: 'Objectives & agents', purpose: 'administration', render: lazy(() => import('./objectives.js')) },
  { id: 'intake', title: 'Intake & cases', purpose: 'research', render: lazy(() => import('./intake.js')) },
  { id: 'evidence', title: 'Evidence', purpose: 'research', render: lazy(() => import('./evidence.js')) },
  { id: 'investigations', title: 'Investigations', purpose: 'research', render: lazy(() => import('./investigations.js')) },
  { id: 'knowledge', title: 'Knowledge', purpose: 'research', render: lazy(() => import('./knowledge.js')) },
  { id: 'correspondence', title: 'Correspondence', purpose: 'correspondence', render: lazy(() => import('./correspondence.js')) },
  { id: 'editorial', title: 'Editorial', purpose: 'editorial', render: lazy(() => import('./editorial.js')) },
  { id: 'production', title: 'Production', purpose: 'production', render: lazy(() => import('./production.js')) },
  { id: 'rights', title: 'Rights', purpose: 'rights', render: lazy(() => import('./rights.js')) },
  { id: 'release', title: 'Release', purpose: 'release', render: lazy(() => import('./release.js')) },
  { id: 'discovery', title: 'Discovery', purpose: 'research', render: lazy(() => import('./discovery.js')) },
  { id: 'resources', title: 'Resources', purpose: 'finance', render: lazy(() => import('./resources.js')) },
  { id: 'audit', title: 'Audit', purpose: 'audit', render: lazy(() => import('./audit.js')) },
  { id: 'admin', title: 'Administration', purpose: 'administration', render: lazy(() => import('./admin.js')) },
  { id: 'search', title: 'Search', purpose: 'workspace', hidden: true, render: lazy(() => import('./search.js')) },
  { id: 'not-found', title: 'Page not found', hidden: true, render: async (el) => { el.append(h('p', { text: 'There is no screen at this address.' }), h('p', {}, h('a', { href: '/overview', 'data-nav': true }, 'Go to the overview'))); } },
];
export { notBuilt };
