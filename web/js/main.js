// PAM browser application: shell, sign-in, organization/project switcher, navigation, global search and inspector.
import * as session from './api.js';
import { h, clear, form, announce, setInspectorOpener, renderError } from './ui.js';
import { createInspector } from './inspector.js';
import { SCREENS } from './screens/index.js';

const $ = (id) => document.getElementById(id);
const main = $('main');
const app = { screen: null, purpose: 'workspace', status: null };
export function currentPurpose() { return app.purpose; }

const inspector = createInspector({ drawer: $('pam-inspector'), body: $('pam-inspector-body'), title: $('pam-inspector-title'), close: $('pam-inspector-close'), purpose: () => app.purpose });
setInspectorOpener((ref) => inspector.open(ref));

function applyBranding() {
  const org = session.currentOrganization();
  const name = org?.organization.name ?? 'Public Accountability Machine';
  $('pam-org-name').textContent = name;
  const branding = org?.organization.branding ?? {};
  const color = typeof branding.primaryColor === 'string' ? branding.primaryColor : typeof branding.colors?.primary === 'string' ? branding.colors.primary : null;
  if (color && /^#[0-9a-fA-F]{3,8}$/.test(color)) document.documentElement.style.setProperty('--pam-brand', color); else document.documentElement.style.removeProperty('--pam-brand');
  const logo = $('pam-logo');
  const logoUrl = typeof branding.logoUrl === 'string' ? branding.logoUrl : null;
  // Only same-origin or data: logos are allowed by the page's content security policy.
  if (logoUrl && (logoUrl.startsWith('/') || logoUrl.startsWith('data:image/'))) { logo.src = logoUrl; logo.alt = `${name} logo`; logo.hidden = false; } else { logo.hidden = true; logo.removeAttribute('src'); }
  const locale = org?.organization.defaultLocale;
  document.documentElement.lang = typeof locale === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale) ? locale : 'en';
}

function renderScope() {
  const sel = $('pam-scope');
  const s = session.session();
  clear(sel);
  for (const o of s.directory?.organizations ?? []) {
    const group = h('optgroup', { label: o.organization.name });
    for (const p of o.projects) group.append(h('option', { value: `${o.organization.id}\u0000${p.id}`, selected: o.organization.id === s.tenantId && p.id === s.projectId ? true : undefined }, `${o.organization.name} · ${p.name}`));
    sel.append(group);
  }
}

function renderNav() {
  const list = $('pam-nav-list');
  clear(list);
  for (const screen of SCREENS.filter((x) => !x.hidden)) {
    list.append(h('li', {}, h('a', { href: `/${screen.id}`, 'data-nav': true, 'aria-current': app.screen === screen ? 'page' : undefined }, screen.title)));
  }
}

function shell(signedIn) {
  $('pam-tools').hidden = !signedIn;
  $('pam-nav').hidden = !signedIn;
  if (!signedIn) inspector.close(false);
}

function signInView() {
  shell(false);
  app.screen = null;
  document.title = 'Sign in · Public Accountability Machine';
  clear(main);
  const intro = h('p', { class: 'pam-intro', text: 'Sign in with your organization account. Your session ends when you sign out or close this tab.' });
  const f = form({ legend: 'Account', submit: 'Sign in', resetOnSuccess: false,
    fields: [{ name: 'login', label: 'Login', required: true, autocomplete: 'username' }, { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' }],
    onSubmit: async (v) => {
      await session.signIn(v.login, v.password);
      queueMicrotask(() => route());
      return 'Signed in.';
    } });
  const status = h('div', { class: 'pam-signin__status' });
  main.append(h('section', { class: 'pam-signin', 'aria-labelledby': 'pam-signin-title' }, h('h1', { id: 'pam-signin-title', tabindex: '-1', text: 'Sign in' }), intro, f, status));
  void session.appApi('/v1/status').then((s) => {
    app.status = s;
    if (s.bootstrapped === false) status.append(h('p', { class: 'ws-notice ws-notice--warn', text: 'No organization exists yet. An operator must run the bootstrap-admin command first.' }));
  }).catch((error) => renderError(status, error));
  $('pam-signin-title').focus();
}

export async function route() {
  const s = session.session();
  if (!s.signedIn) { signInView(); return; }
  shell(true);
  applyBranding();
  renderScope();
  const path = location.pathname.replace(/^\/+/, '').split('/')[0] || 'overview';
  const screen = SCREENS.find((x) => x.id === path) ?? SCREENS.find((x) => x.id === 'not-found');
  app.screen = screen;
  app.purpose = screen.purpose ?? 'workspace';
  renderNav();
  document.title = `${screen.title} · ${session.currentOrganization()?.organization.name ?? 'PAM'}`;
  clear(main);
  const title = h('h1', { tabindex: '-1', id: 'pam-title', text: screen.title });
  const purposeNote = screen.purpose ? h('p', { class: 'pam-purpose', text: `Access purpose for this screen: ${screen.purpose}` }) : null;
  const body = h('div', { class: 'pam-screen', dataset: { screen: screen.id } });
  main.append(title, purposeNote, body);
  try { await screen.render(body, { params: new URLSearchParams(location.search), navigate, purpose: app.purpose, status: app.status, setPurpose: (p) => { app.purpose = p; } }); }
  catch (error) { renderError(body, error, () => route()); }
}

export function navigate(href, { focus = true } = {}) {
  history.pushState(null, '', href);
  void route().then(() => { if (focus) { const t = $('pam-title'); if (t) t.focus(); } });
  const toggle = $('pam-nav-toggle');
  if (toggle.getAttribute('aria-expanded') === 'true') { toggle.setAttribute('aria-expanded', 'false'); $('pam-nav').classList.remove('pam-nav--open'); }
}

document.addEventListener('click', (event) => {
  const a = event.target instanceof Element ? event.target.closest('a[data-nav]') : null;
  if (!a || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', () => { void route(); });
$('pam-scope').addEventListener('change', (event) => {
  const [tenantId, projectId] = event.target.value.split('\u0000');
  session.select(tenantId, projectId);
  inspector.close(false);
  announce('Organization and project changed.');
  void route();
});
$('pam-search').addEventListener('submit', (event) => {
  event.preventDefault();
  const q = $('pam-search-q').value.trim();
  if (q !== '') navigate(`/search?q=${encodeURIComponent(q)}`);
});
$('pam-signout').addEventListener('click', async () => {
  await session.signOut();
  history.pushState(null, '', '/');
  announce('Signed out.');
  void route();
});
$('pam-nav-toggle').addEventListener('click', () => {
  const nav = $('pam-nav');
  const open = !nav.classList.contains('pam-nav--open');
  nav.classList.toggle('pam-nav--open', open);
  $('pam-nav-toggle').setAttribute('aria-expanded', String(open));
});
session.onSessionChange(() => { if (!session.session().signedIn && app.screen !== null) signInView(); });

(async () => {
  try { app.status = await session.appApi('/v1/status'); } catch { app.status = null; }
  try { await session.restore(); } catch (error) { clear(main); renderError(main, error, () => location.reload()); return; }
  await route();
})();
