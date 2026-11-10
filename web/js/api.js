// Session and API access. The refresh token is kept in memory and in sessionStorage (never localStorage). Access tokens
// are issued for exactly one purpose each, cached per purpose and re-issued once when an engine answers 401.
const STORE = 'pam.session';
const state = { refreshToken: null, tenantId: null, projectId: null, directory: null, tokens: new Map(), listeners: new Set() };

export class ApiError extends Error {
  constructor(status, error) {
    super(error?.message ?? `Request failed (${status})`);
    this.name = 'ApiError'; this.status = status; this.code = error?.code ?? (status === 0 ? 'network' : `http_${status}`); this.requestId = error?.requestId ?? null;
    this.engine = error?.engine ?? null;
  }
  /** Display state for the E14 whole-panel components. */
  get panelState() {
    if (this.status === 403 || this.code === 'forbidden') return 'denied';
    if (this.status === 503 || this.status === 0 || this.code === 'unavailable') return 'disconnected';
    return 'error';
  }
}

function save() {
  try {
    if (state.refreshToken === null) sessionStorage.removeItem(STORE);
    else sessionStorage.setItem(STORE, JSON.stringify({ refreshToken: state.refreshToken, tenantId: state.tenantId, projectId: state.projectId }));
  } catch { /* storage unavailable: the session lives in memory only */ }
}
function emit() { for (const fn of state.listeners) fn(); }
export function onSessionChange(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }

async function request(url, init = {}) {
  let res;
  try { res = await fetch(url, init); } catch (error) { throw new ApiError(0, { code: 'network', message: `The server could not be reached (${error instanceof Error ? error.message : 'network error'})` }); }
  return res;
}
async function readError(res) {
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return new ApiError(res.status, body?.error ?? { message: `${res.status} ${res.statusText}` });
}
async function publicPost(path, body) {
  const res = await request(`/api/e/identity${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export function session() {
  return { signedIn: state.refreshToken !== null, tenantId: state.tenantId, projectId: state.projectId, directory: state.directory };
}
export async function restore() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(STORE) ?? 'null'); } catch { saved = null; }
  if (!saved?.refreshToken) return false;
  state.refreshToken = saved.refreshToken; state.tenantId = saved.tenantId ?? null; state.projectId = saved.projectId ?? null;
  try { await loadDirectory(); return true; }
  catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 400 || error.status === 403)) { clearSession(); return false; }
    throw error;
  }
}
export async function signIn(login, password) {
  const out = await publicPost('/v1/sessions', { login, password });
  state.refreshToken = out.refreshToken; state.tokens.clear();
  await loadDirectory();
  return state.directory;
}
export async function loadDirectory() {
  state.directory = await publicPost('/v1/sessions/directory', { refreshToken: state.refreshToken });
  const orgs = state.directory.organizations ?? [];
  const org = orgs.find((o) => o.organization.id === state.tenantId) ?? orgs[0] ?? null;
  const project = org?.projects.find((p) => p.id === state.projectId) ?? org?.projects[0] ?? null;
  state.tenantId = org?.organization.id ?? null; state.projectId = project?.id ?? null;
  save(); emit();
  return state.directory;
}
export function select(tenantId, projectId) {
  if (tenantId === state.tenantId && projectId === state.projectId) return;
  state.tenantId = tenantId; state.projectId = projectId; state.tokens.clear(); save(); emit();
}
export function currentOrganization() {
  return state.directory?.organizations?.find((o) => o.organization.id === state.tenantId) ?? null;
}
export function availablePurposes() { return currentOrganization()?.purposes ?? []; }
function clearSession() { state.refreshToken = null; state.directory = null; state.tokens.clear(); save(); }
export async function signOut() {
  const token = state.refreshToken;
  clearSession(); emit();
  if (token !== null) { try { await publicPost('/v1/sessions/logout', { refreshToken: token }); } catch { /* the local session is gone either way */ } }
}

export async function tokenFor(purpose, fresh = false) {
  if (state.refreshToken === null) throw new ApiError(401, { code: 'unauthenticated', message: 'Not signed in' });
  const cached = state.tokens.get(purpose);
  if (!fresh && cached !== undefined && cached.until > Date.now()) return cached.token;
  let issued;
  try { issued = await publicPost('/v1/tokens', { refreshToken: state.refreshToken, tenantId: state.tenantId, projectId: state.projectId, purpose }); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401) { clearSession(); emit(); }
    throw error;
  }
  const exp = issued.expiresAt ? Date.parse(issued.expiresAt) : Date.now() + 60_000;
  state.tokens.set(purpose, { token: issued.token, until: Math.min(exp - 15_000, Date.now() + 10 * 60_000) });
  return issued.token;
}
/** Drops cached access tokens (after a change of roles, purposes or provisioning). */
export function dropTokens() { state.tokens.clear(); }

/**
 * Calls an engine through the gateway: `api('evidence', '/v1/evidence', { purpose: 'research' })`.
 * Options: method, body (JSON), query (object), raw (return the Response), purpose (required).
 */
export async function api(engine, path, options = {}) {
  const purpose = options.purpose ?? 'workspace';
  const qs = options.query ? `?${new URLSearchParams(Object.entries(options.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]))}` : '';
  const url = `/api/e/${engine}${path}${qs === '?' ? '' : qs}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await tokenFor(purpose, attempt > 0);
    const headers = { authorization: `Bearer ${token}`, ...(options.headers ?? {}) };
    let body;
    if (options.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(options.body); }
    const res = await request(url, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers, body });
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) { const error = await readError(res); error.engine = engine; throw error; }
    if (options.raw) return res;
    if (res.status === 204) return null;
    const type = res.headers.get('content-type') ?? '';
    return type.includes('json') ? res.json() : res.text();
  }
  throw new ApiError(401, { code: 'unauthenticated', message: 'The access token was refused twice' });
}

export async function appApi(path, options = {}) {
  const headers = {};
  if (options.purpose) headers.authorization = `Bearer ${await tokenFor(options.purpose)}`;
  let body;
  if (options.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(options.body); }
  const res = await request(`/api/app${path}`, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers, body });
  if (!res.ok) throw await readError(res);
  return res.json();
}
