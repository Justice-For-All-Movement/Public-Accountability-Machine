// Shared UI helpers for the PAM application. Text is always set as text; nothing is injected as HTML.
import { h, clear, uid, formatTime } from '/engines/workspace/web/dom.js';
import { DataTable, EmptyState, ErrorState, LoadingState, PermissionDeniedState, DisconnectedState, badge } from '/engines/workspace/web/index.js';
import { ApiError } from './api.js';

export { h, clear, uid, formatTime, badge };

let inspectorOpener = () => {};
export function setInspectorOpener(fn) { inspectorOpener = fn; }
export function openInspector(ref) { inspectorOpener(ref); }

const UREF = /^E\d{2}:[a-z_]+:[^\s]+$/;
export const isRef = (value) => typeof value === 'string' && UREF.test(value);
/** A universal reference: a button that opens the inspector drawer for that object. */
export function ref(value, text) {
  if (!isRef(value)) return h('span', { text: value ?? '' });
  return h('button', { type: 'button', class: 'ws-link ws-ref pam-ref', dataset: { ref: value }, title: `Inspect ${value}`, onClick: () => openInspector(value) }, text ?? value);
}
/** Renders any value: urefs become links, arrays are joined, objects are shown as compact JSON text. */
export function value(v) {
  if (v === null || v === undefined || v === '') return h('span', { class: 'ws-muted', text: '—' });
  if (isRef(v)) return ref(v);
  if (Array.isArray(v)) { const span = h('span', {}); v.forEach((x, i) => { if (i > 0) span.append(', '); span.append(value(x)); }); return span; }
  if (typeof v === 'object') return h('code', { class: 'pam-json', text: JSON.stringify(v) });
  if (typeof v === 'boolean') return h('span', { text: v ? 'yes' : 'no' });
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return h('time', { datetime: v, text: formatTime(v) });
  return h('span', { text: String(v) });
}

// ── live region ──
export function announce(message, kind = 'polite') {
  const el = document.getElementById(kind === 'assertive' ? 'pam-alert' : 'pam-status');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = message; }, 30);
}

// ── whole-panel states ──
export function toError(error) {
  if (error instanceof ApiError) return error;
  return new ApiError(-1, { code: 'client_error', message: error instanceof Error ? error.message : String(error) });
}
/** Renders the state matching an error into `el` (permission denied, disconnected or error). */
export function renderError(el, error, onRetry) {
  const e = toError(error);
  clear(el);
  const holder = h('div', { class: 'pam-state', dataset: { state: e.panelState, code: e.code } });
  el.append(holder);
  if (e.panelState === 'denied') PermissionDeniedState(holder, { message: `${e.message}${e.engine ? ` (${e.engine} engine)` : ''}. Your role or the purpose of this screen does not allow this.` });
  else if (e.panelState === 'disconnected') DisconnectedState(holder, { engines: e.engine ? [e.engine] : undefined, reason: e.message, since: new Date().toISOString(), onRetry });
  else ErrorState(holder, { message: e.message, code: e.code, requestId: e.requestId ?? undefined, onRetry });
  return holder;
}
export function renderEmpty(el, title, message, action) {
  clear(el);
  const holder = h('div', { class: 'pam-state', dataset: { state: 'empty' } });
  el.append(holder);
  EmptyState(holder, { title, message, ...(action ? { action } : {}) });
  return holder;
}
/**
 * Loads data into a section: shows a static loading text, then calls render(data, el) or the state matching the failure.
 * Returns a reload function.
 */
export function section(el, load, render, label = 'Loading…') {
  const run = async () => {
    // A confirmation shown by a form inside this section survives the reload that the form itself triggered.
    const kept = [...el.querySelectorAll('.pam-form-status, .pam-action-result')].map((x) => x.textContent).filter((t) => t && !t.startsWith('Sent;')).pop();
    clear(el);
    const holder = h('div', { class: 'pam-state', dataset: { state: 'loading' } });
    el.append(holder);
    LoadingState(holder, { label });
    el.setAttribute('aria-busy', 'true');
    try {
      const data = await load();
      clear(el);
      if (kept) el.append(h('p', { class: 'pam-kept-status ws-notice', text: `Last result: ${kept}` }));
      render(data, el, run);
    } catch (error) { renderError(el, error, run); }
    finally { el.removeAttribute('aria-busy'); }
  };
  void run();
  return run;
}

// ── tables ──
/** DataTable with defaults: columns [{ key, label, render? }]; values rendered with value() unless render is given. */
export function table(el, { caption, columns, rows, emptyText, rowHeader }) {
  const holder = h('div', { class: 'pam-table' });
  el.append(holder);
  DataTable(holder, { caption, rowHeader, emptyText: emptyText ?? 'Nothing recorded yet.', rows, columns: columns.map((c) => ({ sortable: c.sortable ?? !c.render, ...c, render: c.render ?? ((row) => value(row[c.key])) })) });
  return holder;
}
/** Lists objects or shows an empty state when there are none. */
export function listOrEmpty(el, rows, emptyTitle, emptyMessage, spec) {
  if (!Array.isArray(rows) || rows.length === 0) return renderEmpty(el, emptyTitle, emptyMessage);
  return table(el, { ...spec, rows });
}

// ── forms ──
/**
 * form({ legend, fields: [{ name, label, type?, required?, options?, help?, value?, rows?, placeholder? }], submit, onSubmit(values) })
 * Errors returned by the engine are shown in an alert tied to the form; field errors via aria-describedby.
 */
export function form({ legend, fields, submit = 'Save', onSubmit, className, resetOnSuccess = true }) {
  const id = uid('pam-form');
  const errorId = `${id}-error`;
  const statusId = `${id}-status`;
  const inputs = new Map();
  const rows = fields.map((f) => {
    const fid = `${id}-${f.name}`;
    const helpId = f.help ? `${fid}-help` : null;
    const errId = `${fid}-err`;
    const describedBy = [helpId, errId].filter(Boolean).join(' ');
    let input;
    if (f.type === 'select') {
      input = h('select', { id: fid, name: f.name, required: f.required, 'aria-describedby': describedBy }, (f.options ?? []).map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return h('option', { value: opt.value, selected: opt.value === f.value ? true : undefined }, opt.label);
      }));
    } else if (f.type === 'textarea') {
      input = h('textarea', { id: fid, name: f.name, rows: f.rows ?? 4, required: f.required, placeholder: f.placeholder, 'aria-describedby': describedBy });
      if (f.value !== undefined) input.value = f.value;
    } else if (f.type === 'checkbox') {
      input = h('input', { id: fid, name: f.name, type: 'checkbox', checked: f.value === true ? true : undefined, 'aria-describedby': describedBy });
    } else {
      input = h('input', { id: fid, name: f.name, type: f.type ?? 'text', required: f.required, placeholder: f.placeholder, autocomplete: f.autocomplete ?? 'off', min: f.min, step: f.step, accept: f.accept, 'aria-describedby': describedBy });
      if (f.value !== undefined && f.type !== 'file') input.value = f.value;
    }
    inputs.set(f.name, { input, field: f, errId });
    return h('div', { class: `pam-field${f.type === 'checkbox' ? ' pam-field--check' : ''}` },
      f.type === 'checkbox' ? [input, h('label', { for: fid, text: f.label })] : [h('label', { for: fid }, f.label, f.required ? h('span', { class: 'pam-req', text: ' (required)' }) : null), input],
      f.help ? h('p', { id: helpId, class: 'pam-help', text: f.help }) : null,
      h('p', { id: errId, class: 'pam-field-error', hidden: true }));
  });
  const error = h('div', { id: errorId, class: 'pam-form-error', role: 'alert', hidden: true });
  const status = h('p', { id: statusId, class: 'pam-form-status', role: 'status' });
  const button = h('button', { type: 'submit', class: 'ws-button ws-button--primary' }, submit);
  const el = h('form', { class: `pam-form ${className ?? ''}`, novalidate: true, 'aria-describedby': errorId },
    h('fieldset', {}, legend ? h('legend', { text: legend }) : null, rows, h('div', { class: 'pam-form-actions' }, button), error, status));
  const values = async () => {
    const out = {};
    for (const [name, { input, field }] of inputs) {
      if (field.type === 'checkbox') out[name] = input.checked;
      else if (field.type === 'file') out[name] = input.files?.[0] ?? null;
      else if (field.type === 'number') out[name] = input.value === '' ? undefined : Number(input.value);
      else out[name] = input.value.trim();
    }
    return out;
  };
  el.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true; error.textContent = ''; status.textContent = '';
    let firstBad = null;
    for (const { input, field, errId } of inputs.values()) {
      const errEl = document.getElementById(errId) ?? el.querySelector(`#${CSS.escape(errId)}`);
      const empty = field.type === 'file' ? !(input.files && input.files.length > 0) : field.type === 'checkbox' ? false : input.value.trim() === '';
      if (field.required && empty) {
        input.setAttribute('aria-invalid', 'true');
        if (errEl) { errEl.hidden = false; errEl.textContent = `${field.label} is required.`; }
        firstBad = firstBad ?? input;
      } else { input.removeAttribute('aria-invalid'); if (errEl) { errEl.hidden = true; errEl.textContent = ''; } }
    }
    if (firstBad) { firstBad.focus(); return; }
    button.disabled = true;
    status.textContent = 'Sent; waiting for the engine to answer.';
    try {
      const message = await onSubmit(await values(), el);
      status.textContent = typeof message === 'string' ? message : 'Done.';
      announce(status.textContent);
      if (resetOnSuccess) el.reset();
    } catch (err) {
      const e = toError(err);
      status.textContent = '';
      error.hidden = false;
      error.textContent = `${e.panelState === 'denied' ? 'Not permitted: ' : e.panelState === 'disconnected' ? 'Engine unavailable: ' : 'Refused: '}${e.message}${e.code ? ` (${e.code})` : ''}`;
      announce(error.textContent, 'assertive');
    } finally { button.disabled = false; }
  });
  return el;
}

/** A button that runs an async action and reports the real outcome in the live region and next to the button. */
export function action(label, run, { danger = false, confirmText } = {}) {
  const out = h('span', { class: 'pam-action-result', role: 'status' });
  const btn = h('button', { type: 'button', class: `ws-button${danger ? ' ws-button--danger' : ''}` }, label);
  btn.addEventListener('click', async () => {
    if (confirmText && !window.confirm(confirmText)) return;
    btn.disabled = true; out.textContent = 'Sent; waiting for the engine to answer.';
    try { const msg = await run(); out.textContent = typeof msg === 'string' ? msg : `${label}: done.`; announce(out.textContent); }
    catch (err) { const e = toError(err); out.textContent = `${label} refused: ${e.message} (${e.code})`; announce(out.textContent, 'assertive'); }
    finally { btn.disabled = false; }
  });
  return h('span', { class: 'pam-action' }, btn, out);
}

export function heading(level, text, attrs = {}) { return h(`h${level}`, { ...attrs, text }); }
/** A titled region within a screen. Returns { el, body }. */
export function region(title, level = 2, intro) {
  const hid = uid('pam-region');
  const body = h('div', { class: 'pam-region__body' });
  const el = h('section', { class: 'pam-region', 'aria-labelledby': hid }, h(`h${level}`, { id: hid, text: title }), intro ? h('p', { class: 'pam-intro', text: intro }) : null, body);
  return { el, body };
}
export function dl(pairs) {
  return h('dl', { class: 'pam-dl' }, pairs.filter(([, v]) => v !== undefined).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', {}, v instanceof Node ? v : value(v))]));
}
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, class: 'pam-hidden-link' }, 'download');
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export function b64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const s = String(reader.result); resolve(s.slice(s.indexOf(',') + 1)); };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
export function bytesFromB64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
/** Shows untrusted HTML only inside a sandboxed iframe without scripts (blob URL), never in the page. */
export function sandboxedHtml(html, title) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const frame = h('iframe', { class: 'pam-sandbox', sandbox: '', title, src: url, referrerpolicy: 'no-referrer' });
  return frame;
}
export const arr = (x, key) => (Array.isArray(x) ? x : Array.isArray(x?.[key]) ? x[key] : Array.isArray(x?.items) ? x.items : []);
