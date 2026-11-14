// The signed-in person's own account security: two-factor sign-in with an authenticator app (identity engine E01).
import { api } from '../api.js';
import { h, form, section, region, dl, action, announce } from '../ui.js';

export async function render(el, ctx) {
  const { el: box, body: boxBody } = region('Two-factor sign-in', 2, 'With two-factor sign-in on, signing in needs your password and a six-digit code from an authenticator app on your phone. Keep the recovery codes somewhere safe: each one replaces a code once if you lose the phone.');
  el.append(box);
  const body = h('div', {}); boxBody.append(body);
  const call = (path, bodyValue, method) => api('identity', path, { purpose: ctx.purpose, ...(bodyValue === undefined ? {} : { body: bodyValue }), ...(method ? { method } : {}) });
  const reload = section(body, () => call('/v1/mfa'), (status, target) => {
    target.append(dl([['Status', status.enabled ? 'On' : status.pending ? 'Setup started, not yet confirmed' : 'Off'], ...(status.enabled ? [['Recovery codes left', String(status.recoveryCodesLeft)]] : [])]));
    if (status.enabled) {
      target.append(form({ legend: 'Turn two-factor sign-in off', submit: 'Turn off', fields: [{ name: 'code', label: 'Current six-digit code, or a recovery code', required: true, autocomplete: 'one-time-code' }],
        onSubmit: async (v) => { const c = v.code.trim(); await call('/v1/mfa/disable', /^\d{6}$/.test(c) ? { code: c } : { recoveryCode: c }); queueMicrotask(reload); return 'Two-factor sign-in is off.'; } }));
      return;
    }
    const setup = h('div', {}); target.append(setup);
    setup.append(action('Start setup', async () => {
      const out = await call('/v1/mfa/enroll', {});
      setup.replaceChildren(
        h('p', { text: 'Add an account in your authenticator app with this setup key (or open the link on the phone). Then enter the six-digit code the app shows.' }),
        dl([['Setup key', out.secret]]),
        h('p', {}, h('a', { href: out.otpauthUri, text: 'Open in authenticator app' })),
        form({ legend: 'Confirm setup', submit: 'Confirm', fields: [{ name: 'code', label: 'Six-digit code from the app', required: true, autocomplete: 'one-time-code' }],
          onSubmit: async (v) => {
            const done = await call('/v1/mfa/confirm', { code: v.code.trim() });
            setup.replaceChildren(h('p', { class: 'ws-notice', text: 'Two-factor sign-in is on. Save these recovery codes now; they are not shown again.' }),
              h('ul', { class: 'pam-recovery-codes' }, ...done.recoveryCodes.map((c) => h('li', {}, h('code', { text: c })))),
              action('I have saved them', async () => { reload(); return 'Done.'; }));
            announce('Two-factor sign-in is on. Save the recovery codes shown.');
            return 'Two-factor sign-in is on.';
          } }));
      return 'Setup started.';
    }));
  });
}
