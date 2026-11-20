// In-app help: help bubbles (toggle) and a guided tour of the current page. Text lives in help.js.
// Help mode: pointing at, or keyboard-focusing, a section heading, a header control or a recurring element shows a bubble.
// Tour: steps through the page (frame, then each section shown, in page order) with Back / Next / Close.
// Accessible: bubbles are role="tooltip" tied with aria-describedby; the tour is a non-modal dialog that takes focus,
// Escape closes either. The help-mode setting is remembered in this browser only.
import { SHELL, ELEMENTS, SCREENS } from './help.js';

const KEY = 'pam.help';
let enabled = false, bubble = null, anchor = null, tour = null;
const store = { get() { try { return localStorage.getItem(KEY) === 'on'; } catch { return false; } }, set(v) { try { localStorage.setItem(KEY, v ? 'on' : 'off'); } catch { /* not stored */ } } };

function screenId() { return document.querySelector('.pam-screen')?.dataset.screen ?? null; }
function sectionHelp(heading) {
  const list = SCREENS[screenId()] ?? [];
  const t = heading.textContent.trim();
  const hit = list.find(([title]) => title === t);
  return hit ? { title: hit[0], text: hit[1] } : null;
}
/** The help for an element under the pointer or focus, and the element to anchor the bubble to. */
function helpFor(target) {
  if (!(target instanceof Element)) return null;
  const heading = target.closest('.pam-region > h2, .pam-region > h3');
  if (heading) { const h = sectionHelp(heading); if (h) return { el: heading, ...h }; }
  for (const x of [...SHELL, ...ELEMENTS]) { const el = target.closest(x.selector); if (el) return { el, title: x.title, text: x.text }; }
  return null;
}

function hideBubble() {
  if (anchor) anchor.removeAttribute('aria-describedby');
  bubble?.remove(); bubble = null; anchor = null;
}
function place(box, el) {
  const r = el.getBoundingClientRect(); const w = Math.min(320, window.innerWidth - 16);
  box.style.maxWidth = `${w}px`;
  const left = Math.min(Math.max(8, r.left + window.scrollX), window.scrollX + window.innerWidth - w - 8);
  box.style.left = `${left}px`;
  const below = r.bottom + window.scrollY + 8;
  box.style.top = `${below}px`;
  if (r.bottom + box.offsetHeight + 16 > window.innerHeight && r.top > box.offsetHeight + 16) box.style.top = `${r.top + window.scrollY - box.offsetHeight - 8}px`;
}
function showBubble(help) {
  if (anchor === help.el) return;
  hideBubble();
  bubble = document.createElement('div');
  bubble.className = 'pam-help-bubble'; bubble.id = 'pam-help-bubble'; bubble.setAttribute('role', 'tooltip');
  const t = document.createElement('p'); t.className = 'pam-help-bubble__title'; t.textContent = help.title;
  const p = document.createElement('p'); p.textContent = help.text;
  bubble.append(t, p); document.body.append(bubble);
  anchor = help.el; anchor.setAttribute('aria-describedby', bubble.id);
  place(bubble, anchor);
}
function onPoint(event) {
  if (!enabled || tour) return;
  if (event.target instanceof Element && event.target.closest('.pam-help-bubble')) return;
  const help = helpFor(event.target);
  if (help) showBubble(help); else hideBubble();
}

export function setEnabled(on, remember = true) {
  enabled = on; if (remember) store.set(on);   // stored only when the person flips the toggle
  document.documentElement.classList.toggle('pam-help-on', on);
  const btn = document.getElementById('pam-help-toggle');
  if (btn) { btn.setAttribute('aria-pressed', String(on)); btn.textContent = on ? 'Help bubbles: on' : 'Help bubbles: off'; }
  if (!on) hideBubble();
}

/** The tour of the current page: frame parts that are visible, then every section that has help, in page order. */
export function tourSteps() {
  const visible = (el) => el && !el.closest('[hidden]') && el.getClientRects().length > 0;
  const steps = [];
  for (const x of SHELL) { const el = document.querySelector(x.selector); if (visible(el)) steps.push({ el, title: x.title, text: x.text }); }
  for (const heading of document.querySelectorAll('.pam-screen .pam-region > h2, .pam-screen .pam-region > h3')) {
    const h = sectionHelp(heading); if (h && visible(heading)) steps.push({ el: heading.closest('.pam-region'), title: h.title, text: h.text });
  }
  return steps;
}
export function startTour() {
  endTour(false); hideBubble();
  const steps = tourSteps(); if (steps.length === 0) return;
  const box = document.createElement('div');
  box.className = 'pam-help-bubble pam-help-tour'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'false'); box.setAttribute('aria-labelledby', 'pam-tour-title'); box.tabIndex = -1;
  const count = document.createElement('p'); count.className = 'pam-help-bubble__count';
  const title = document.createElement('p'); title.className = 'pam-help-bubble__title'; title.id = 'pam-tour-title';
  const text = document.createElement('p');
  const bar = document.createElement('div'); bar.className = 'pam-help-tour__bar';
  const mk = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ws-button'; b.textContent = label; b.addEventListener('click', fn); return b; };
  const back = mk('Back', () => go(tour.i - 1)), next = mk('Next', () => (tour.i === steps.length - 1 ? endTour(true) : go(tour.i + 1))), close = mk('Close tour', () => endTour(true));
  bar.append(back, next, close); box.append(count, title, text, bar); document.body.append(box);
  tour = { steps, i: 0, box, opener: document.activeElement };
  function go(i) {
    tour.steps[tour.i]?.el.classList.remove('pam-help-target');
    tour.i = Math.max(0, Math.min(i, steps.length - 1));
    const s = steps[tour.i];
    count.textContent = `Step ${tour.i + 1} of ${steps.length}`; title.textContent = s.title; text.textContent = s.text;
    back.disabled = tour.i === 0; next.textContent = tour.i === steps.length - 1 ? 'Finish' : 'Next';
    s.el.classList.add('pam-help-target');
    s.el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    requestAnimationFrame(() => place(box, s.el));
    box.focus();
  }
  go(0);
}
export function endTour(restoreFocus) {
  if (!tour) return;
  tour.steps[tour.i]?.el.classList.remove('pam-help-target');
  tour.box.remove();
  const opener = tour.opener; tour = null;
  if (restoreFocus && opener instanceof HTMLElement) opener.focus();
}

/** Builds the header controls and starts listening. Call once. */
export function installHelp(container) {
  const wrap = document.createElement('div'); wrap.className = 'pam-help-tools'; wrap.id = 'pam-help-tools';
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'ws-button'; toggle.id = 'pam-help-toggle';
  toggle.addEventListener('click', () => setEnabled(!enabled));
  const tourBtn = document.createElement('button'); tourBtn.type = 'button'; tourBtn.className = 'ws-button'; tourBtn.id = 'pam-tour-start'; tourBtn.textContent = 'Tour this page';
  tourBtn.addEventListener('click', startTour);
  wrap.append(toggle, tourBtn); container.prepend(wrap);
  document.addEventListener('mouseover', onPoint);
  document.addEventListener('focusin', onPoint);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (tour) endTour(true); else hideBubble(); } });
  window.addEventListener('resize', () => { hideBubble(); if (tour) place(tour.box, tour.steps[tour.i].el); });
  setEnabled(store.get(), false);
}
/** Called after every page change: closes bubbles and any tour from the previous page. */
export function onRoute() { hideBubble(); endTour(false); }
