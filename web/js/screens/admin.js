// Administration (E01 + PAM provisioning): members and roles, agents and the agent-token policy, capability grants,
// compartments, purposes, and running PAM's provisioning for this organization.
import { api, appApi, dropTokens, loadDirectory } from '../api.js';
import { h, region, section, table, renderEmpty, form, action, dl, ref } from '../ui.js';

const words = (s) => (s ?? '').split(/[\s,]+/).filter(Boolean);

export async function render(el, ctx) {
  const prov = region('Provisioning'); const members = region('Members and roles'); const agents = region('Agents and agent tokens'); const grants = region('Capability grants');
  const comps = region('Compartments'); const roles = region('Roles'); const purposes = region('Purposes');
  el.append(prov.el, members.el, agents.el, grants.el, comps.el, roles.el, purposes.el);
  prov.body.append(h('p', { text: 'Creates PAM’s service identity in this organization (so workers and the event router can act here) and aligns the role catalog. Safe to run again.' }),
    action('Run provisioning', async () => {
      const out = await appApi('/v1/provision', { purpose: ctx.purpose, method: 'POST', body: {} });
      let rounds = 0;
      // Each catalog change invalidates the current token: ask again with a fresh token until nothing is left to align.
      for (; rounds < 20; rounds++) { dropTokens(); const r = await appApi('/v1/provision/roles', { purpose: ctx.purpose, method: 'POST', body: {} }); if (!r.again) break; }
      dropTokens(); await loadDirectory();
      return `Provisioning ${out.created ? 'created the service identity' : 'found the service identity already present'}; role catalog aligned after ${rounds + 1} pass(es).`;
    }));
  const reloadMembers = section(members.body, async () => ({ members: await api('identity', '/v1/members', { purpose: ctx.purpose }), roles: await api('identity', '/v1/roles', { purpose: ctx.purpose }) }), ({ members: rows, roles: rs }, body) => {
    table(body, { caption: `Members (${rows.length})`, rows: rows.map((m) => ({ ...m, name: m.actor.displayName, kind: m.actor.kind, login: m.actor.login, actorId: m.actor.id })), rowHeader: 'name', columns: [{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind' }, { key: 'login', label: 'Login' }, { key: 'projectId', label: 'Project' }, { key: 'roles', label: 'Roles' }, { key: 'status', label: 'Status' }, { key: 'actorId', label: 'Actor id' }] });
    const humanRoles = rs.filter((r) => r.actorKinds.includes('human')).map((r) => r.name);
    body.append(form({ legend: 'Set roles of a member', submit: 'Set roles', fields: [{ name: 'actorId', label: 'Member', type: 'select', options: rows.map((m) => ({ value: m.actor.id, label: `${m.actor.displayName} (${m.projectId})` })) }, { name: 'roles', label: `Roles (space separated; available: ${humanRoles.join(', ')})`, required: true }],
      onSubmit: async (v) => { await api('identity', '/v1/members', { method: 'PUT', purpose: ctx.purpose, body: { actorId: v.actorId, roles: words(v.roles) } }); setTimeout(reloadMembers, 0); return 'Roles set.'; } }));
    body.append(form({ legend: 'Add a person', submit: 'Create account', fields: [{ name: 'displayName', label: 'Name', required: true }, { name: 'login', label: 'Login', required: true }, { name: 'password', label: 'Initial password', type: 'password', required: true, autocomplete: 'new-password' }, { name: 'roles', label: 'Roles in this project (space separated)', required: true }],
      onSubmit: async (v) => { await api('identity', '/v1/users', { purpose: ctx.purpose, body: { displayName: v.displayName, login: v.login, password: v.password, projectId: (await import('../api.js')).session().projectId, roles: words(v.roles) } }); setTimeout(reloadMembers, 0); return 'Account created.'; } }));
  });
  section(agents.body, async () => ({ agents: await api('identity', '/v1/agents', { purpose: ctx.purpose }), org: await api('identity', '/v1/organization', { purpose: ctx.purpose }), roles: await api('identity', '/v1/roles', { purpose: ctx.purpose }) }), ({ agents: rows, org, roles: rs }, body) => {
    if (!rows.length) renderEmpty(body.appendChild(h('div', {})), 'No agents', 'Agents are durable identities with no credential; they act only with short-lived tokens carrying listed capabilities.');
    else table(body, { caption: `Agents (${rows.length})`, rows, rowHeader: 'displayName', columns: [{ key: 'displayName', label: 'Agent' }, { key: 'status', label: 'Status' }, { key: 'description', label: 'Description' }, { key: 'id', label: 'Actor id' }, { key: 'createdAt', label: 'Created' }] });
    body.append(dl([['Actions agents may be granted (organization policy)', (org.policyConfig?.agentGrantableActions ?? []).length ? org.policyConfig.agentGrantableActions : 'none (approve, publish and identity disclosure are withheld from agents)']]));
    body.append(form({ legend: 'Agent-token policy', submit: 'Save policy', fields: [{ name: 'actions', label: 'Sensitive actions agents may be granted (space separated: approve publish disclose_identity)', value: (org.policyConfig?.agentGrantableActions ?? []).join(' ') }],
      onSubmit: async (v) => { await api('identity', '/v1/organization', { method: 'PATCH', purpose: ctx.purpose, body: { policyConfig: { ...(org.policyConfig ?? {}), agentGrantableActions: words(v.actions) } } }); dropTokens(); return 'Policy saved (a new policy version invalidates current tokens).'; } }));
    const agentRoles = rs.filter((r) => r.actorKinds.includes('agent')).map((r) => r.name);
    body.append(form({ legend: 'New agent identity', submit: 'Create agent', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'description', label: 'Description' }, { name: 'roles', label: `Roles (available: ${agentRoles.join(', ')})`, required: true }],
      onSubmit: async (v) => { await api('identity', '/v1/agents', { purpose: ctx.purpose, body: { name: v.name, ...(v.description ? { description: v.description } : {}), roles: words(v.roles) } }); return 'Agent created.'; } }));
  });
  const reloadGrants = section(grants.body, () => api('identity', '/v1/capability-grants', { purpose: ctx.purpose }), (rows, body) => {
    if (!rows.length) renderEmpty(body.appendChild(h('div', {})), 'No grants', 'A grant gives one actor one exact capability for one purpose, for a limited time.');
    else table(body, { caption: `Grants (${rows.length})`, rows, columns: [{ key: 'actorId', label: 'Actor' }, { key: 'capability', label: 'Capability' }, { key: 'purpose', label: 'Purpose' }, { key: 'resource', label: 'Resource' }, { key: 'expiresAt', label: 'Expires' }, { key: 'uses', label: 'Uses', numeric: true }, { key: 'ref', label: 'Reference', render: (g) => ref(g.ref) },
      { key: 'rev', label: 'Revoke', sortable: false, render: (g) => action('Revoke', async () => { await api('identity', `/v1/grants/${g.id}/revoke`, { purpose: ctx.purpose, body: { reason: 'Revoked in PAM' } }); setTimeout(reloadGrants, 300); return 'Revoked.'; }, { danger: true }) }] });
    body.append(form({ legend: 'New grant', submit: 'Create grant', fields: [{ name: 'actorId', label: 'Actor id', required: true }, { name: 'capability', label: 'Capability (exact, for example evidence:export)', required: true }, { name: 'purpose', label: 'Purpose', required: true }, { name: 'resource', label: 'Resource (uref, optional)' }, { name: 'reason', label: 'Reason', required: true }, { name: 'expiresAt', label: 'Expires at', type: 'datetime-local', required: true }],
      onSubmit: async (v) => { await api('identity', '/v1/capability-grants', { purpose: ctx.purpose, body: { actorId: v.actorId, capability: v.capability, purpose: v.purpose, reason: v.reason, expiresAt: new Date(v.expiresAt).toISOString(), ...(v.resource ? { resource: v.resource } : {}) } }); setTimeout(reloadGrants, 0); return 'Grant created.'; } }));
  });
  const reloadComps = section(comps.body, () => api('identity', '/v1/compartments', { purpose: ctx.purpose }), (rows, body) => {
    if (!rows.length) renderEmpty(body.appendChild(h('div', {})), 'No compartments', 'Compartments restrict objects to named members.');
    else table(body, { caption: `Compartments (${rows.length})`, rows, columns: [{ key: 'id', label: 'Compartment' }, { key: 'projectId', label: 'Project' }, { key: 'description', label: 'Description' }, { key: 'members', label: 'Members' }] });
    body.append(form({ legend: 'New compartment', submit: 'Create compartment', fields: [{ name: 'id', label: 'Compartment id', required: true }, { name: 'description', label: 'Description' }], onSubmit: async (v) => { await api('identity', '/v1/compartments', { purpose: ctx.purpose, body: { id: v.id, ...(v.description ? { description: v.description } : {}) } }); setTimeout(reloadComps, 0); return 'Compartment created.'; } }));
    if (rows.length) body.append(form({ legend: 'Compartment membership', submit: 'Apply', fields: [{ name: 'compartmentId', label: 'Compartment', type: 'select', options: rows.map((c) => c.id) }, { name: 'actorId', label: 'Actor id', required: true }, { name: 'member', label: 'Member (untick to remove)', type: 'checkbox', value: true }],
      onSubmit: async (v) => { await api('identity', `/v1/compartments/${encodeURIComponent(v.compartmentId)}/members`, { method: 'PUT', purpose: ctx.purpose, body: { actorId: v.actorId, member: v.member } }); setTimeout(reloadComps, 0); return 'Membership updated.'; } }));
  });
  section(roles.body, () => api('identity', '/v1/roles', { purpose: ctx.purpose }), (rows, body) => table(body, { caption: `Roles (${rows.length})`, rows, rowHeader: 'name', columns: [{ key: 'name', label: 'Role' }, { key: 'description', label: 'Description' }, { key: 'actorKinds', label: 'For' }, { key: 'capabilities', label: 'Capabilities' }, { key: 'version', label: 'Version', numeric: true }] }));
  section(purposes.body, () => api('identity', '/v1/purposes', { purpose: ctx.purpose }), (rows, body) => table(body, { caption: `Purposes (${rows.length})`, rows, rowHeader: 'name', columns: [{ key: 'name', label: 'Purpose' }, { key: 'description', label: 'Description' }, { key: 'capabilities', label: 'Capabilities' }] }));
}
