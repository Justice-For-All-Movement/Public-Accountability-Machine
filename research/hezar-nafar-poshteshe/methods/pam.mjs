// Small client for the hosted PAM: signs in as the administrator and calls engines through the gateway with
// project-scoped, purpose-bound access tokens (the same path the browser uses). Prints no secrets.
import { readFileSync } from 'node:fs';
export const BASE = 'https://pam-em80.onrender.com';
export const PROJECT = 'hezar-nafar-poshteshe';
const S = process.env.HEZAR_WORKDIR ?? '.';
async function raw(method, path, body, token) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try { r = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch (e) { if (attempt < 4) { await new Promise((ok) => setTimeout(ok, 5000 * (attempt + 1))); continue; } throw e; }
    if ((r.status === 502 || r.status === 503) && attempt < 4) { await new Promise((ok) => setTimeout(ok, 8000 * (attempt + 1))); continue; }
    const t = await r.text(); let b = t; try { b = JSON.parse(t); } catch {}
    if (!r.ok) { const e = new Error(`${method} ${path} → ${r.status} ${t.slice(0, 400)}`); e.status = r.status; e.body = b; throw e; }
    return b;
  }
}
let refresh = null, tenant = null; const tokens = new Map();
export async function signIn() {
  const pw = readFileSync(`${S}/pam-admin.txt`, 'utf8').match(/password: (\S+)/)[1];
  refresh = (await raw('POST', '/api/e/identity/v1/sessions', { login: 'admin@example.org', password: pw })).refreshToken;
  const dir = await raw('POST', '/api/e/identity/v1/sessions/directory', { refreshToken: refresh });
  tenant = dir.organizations[0].organization.id;
  return { tenant, purposes: dir.organizations[0].purposes };
}
export async function token(purpose, project = PROJECT) {
  const k = `${project}:${purpose}`; const c = tokens.get(k);
  if (c && c.until > Date.now()) return c.token;
  const t = await raw('POST', '/api/e/identity/v1/tokens', { refreshToken: refresh, tenantId: tenant, projectId: project, purpose });
  tokens.set(k, { token: t.token, until: Date.parse(t.expiresAt) - 30_000 }); return t.token;
}
export const engine = async (name, method, path, body, purpose = 'research', project = PROJECT) => raw(method, `/api/e/${name}${path}`, body, await token(purpose, project));
export const app = async (method, path, body, purpose = 'workspace', project = PROJECT) => raw(method, `/api/app${path}`, body, await token(purpose, project));
export async function signOut() { if (refresh) await raw('POST', '/api/e/identity/v1/sessions/logout', { refreshToken: refresh }).catch(() => {}); }

// Research log: every step is appended to the project's log investigation (E08 attempts). Append-only; a correction
// is a new entry naming the one it corrects.
import { existsSync as _ex, readFileSync as _rf } from 'node:fs';
export const LOG_ID = _ex(new URL('./log-id.txt', import.meta.url)) ? _rf(new URL('./log-id.txt', import.meta.url), 'utf8').trim() : null;
export async function logStep(entry) {
  if (!LOG_ID) throw new Error('No research log investigation');
  return engine('investigation', 'POST', `/v1/investigations/${LOG_ID}/attempts`, entry);
}
