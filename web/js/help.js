// In-app help: the text of the help bubbles and of the guided tour of each page. Keys are the screen id (see
// screens/index.js) and, inside a screen, the exact title of a section. Order within a screen is the tour order (the
// tour follows the page's own order and skips sections that are not shown). Keep each text short: what the part is for,
// how to use it, and any rule it enforces.

/** Parts of the application frame, present on every page. `selector` finds the element. */
export const SHELL = [
  { id: 'nav', selector: '#pam-nav', title: 'Main menu', text: 'Every area of PAM. Each area talks to one or more engines (evidence, knowledge, investigations…). The menu is the same for everyone; what you can see and do inside each area depends on your role.' },
  { id: 'scope', selector: '.pam-switcher', title: 'Organization and project', text: 'Everything you see belongs to the organization and project chosen here. Projects keep cases apart: records, evidence and decisions in one project are not visible from another.' },
  { id: 'search', selector: '#pam-search', title: 'Search all engines', text: 'Searches records you are allowed to see across every engine at once: evidence, claims, people, investigations, messages and more.' },
  { id: 'help', selector: '#pam-help-tools', title: 'Help', text: 'Help bubbles explain whatever you point at (or reach with the keyboard). "Tour this page" walks through the current page step by step.' },
  { id: 'signout', selector: '#pam-signout', title: 'Sign out', text: 'Ends your session on the server, not just in this browser. Sign out on shared computers.' },
  { id: 'title', selector: '#pam-title', title: 'This page', text: 'The name of the area you are in.' },
  { id: 'purpose', selector: '.pam-purpose', title: 'Access purpose', text: 'PAM issues a separate access pass for each purpose (research, correspondence, release…). This page works under the purpose shown, and the engines check every action against it: being allowed to research does not make you allowed to publish.' },
];

/** Recurring kinds of element. `selector` matches any number of elements on a page; help mode explains them on hover. */
export const ELEMENTS = [
  { id: 'ref', selector: '.pam-ref', title: 'Record reference', text: 'A link to one exact record (for example E05:evidence_version:…@2 is revision 2 of an evidence item). Click it to open the inspector: what the record is, where it came from, what depends on it, and the actions your role allows.' },
  { id: 'inspector', selector: '#pam-inspector', title: 'Inspector', text: 'Details of the record you clicked: its content, sources, dependents (as a graph, table or text) and controls. Close it to return to the page.' },
  { id: 'state', selector: '.pam-state', title: 'State of this panel', text: 'Shown when a panel cannot show data: Disconnected (its engine is not running), Not found or not permitted (your role or purpose does not allow it), or empty. PAM never shows something as done or available before the engine says so.' },
  { id: 'table', selector: '.pam-table', title: 'Table', text: 'Columns with a button in the heading can be sorted. Links inside open the record in the inspector.' },
  { id: 'action', selector: '.pam-action', title: 'Action', text: 'Runs one action in an engine. The result appears next to the button; if the engine refuses, the reason is shown and nothing is changed.' },
];

/** Page sections, by screen id and exact section title, in tour order. */
export const SCREENS = {
  overview: [
    ['Needs attention', 'Items that became stale, blocked, failed or uncertain, inquiries that went unanswered, and work waiting for a review. Only items you may see are listed. "Acknowledge" hides an item for you; it changes nothing in the engines.'],
    ['Engines', 'Which engines are running in this deployment and what they report. A stopped engine shows as unavailable; its pages show "Disconnected".'],
    ['Orchestration', 'The automated work: objectives, tasks by state, what is running now, failures and work awaiting approval.'],
    ['Budgets', 'Spending and usage limits (money, model tokens, messages) and how much of each is used. Agents can only spend from a budget assigned to them.'],
  ],
  objectives: [
    ['Objectives', 'An objective is a goal the system works toward, such as "research every person on this list". Runs and tasks belong to an objective.'],
    ['New objective', 'Create a goal: a title, what it means, and the research lane it belongs to.'],
    ['Agents', 'Durable automated workers. Each agent acts with its own identity and only the capabilities and budget it is given.'],
    ['New agent', 'Create an agent and decide what it may do. Give it the least it needs.'],
    ['Objective', 'One objective in detail: its directives (standing instructions) and status.'],
    ['Task board', 'Every task of the selected objective by state. Pause, resume, retry, reassign, approve or reject tasks here; approvals are recorded with your name.'],
    ['Runs', 'Each run is one attempt at an objective: a set of tasks with dependencies, checkpoints and results.'],
    ['Start a run', 'Start a run with chosen tasks (each task names an action, such as a model-backed extraction, and its input).'],
  ],
  intake: [
    ['Intake application', 'Intake is a separate application where people submit accounts and documents safely, even anonymously. This shows where it is and whether PAM is connected to it.'],
    ['Investigations opened from intake', 'Submissions that became investigations here, with links to each.'],
  ],
  evidence: [
    ['Add evidence', 'Upload a file. It is stored unchanged, fingerprinted (SHA-256), scanned, and given a provenance record. Never edit evidence: a corrected file is a new revision.'],
    ['Evidence items', 'Everything stored in this project. Click an item to see it.'],
    ['Item', 'The selected item: its revisions, size, type, fingerprint and handling restrictions.'],
    ['Viewer', 'The content itself, shown safely. Some uses (for example publishing) need a separate permission.'],
    ['Provenance and custody', 'Where the item came from and every time it was accessed or changed: the chain of custody a court or critic can check.'],
    ['Actions', 'Verify the fingerprint, add a redacted derivative, set retention, or place a hold. Each action is recorded.'],
  ],
  investigations: [
    ['Investigations', 'Each investigation pursues one account or question to a documented conclusion.'],
    ['Open an investigation', 'Start from an account, recorded as an allegation (never as a fact), with its scope and any contact constraints.'],
    ['Question tree', 'The questions the investigation must answer, broken down. Each question ends answered, unanswerable or out of scope, with the reason.'],
    ['Explanations (hypotheses)', 'Competing explanations, kept side by side until the evidence decides. Recording alternatives protects against tunnel vision.'],
    ['Attempts log', 'Every search, request, contact and check, including those that found nothing. A project\'s research log is an investigation like this; its attempts are the step-by-step record of the work.'],
    ['Findings', 'Conclusions with their evidence and limitations. A finding is submitted for review before it counts.'],
    ['Closure and packages', 'Closing is blocked while material questions are open. A package bundles findings, evidence and unknowns for editorial or release.'],
  ],
  knowledge: [
    ['Claims', 'Statements made by sources, each tied to evidence. A claim is what a source says, not what is true; assessments say how well it is supported.'],
    ['New claim', 'Record a statement with its source evidence and the exact place in it (page, quote, timestamp).'],
    ['Proposals awaiting review', 'Claims, people and links proposed by imports and agents. Nothing becomes a record until a person accepts it; the reason is kept.'],
    ['Research gaps', 'Claims without enough support, questions without evidence: where to look next.'],
    ['Chronology', 'Events in date order, from all claims and records.'],
    ['Claim', 'One claim in detail: its text, sources and revisions.'],
    ['Assessment tracks', 'How well the claim is supported, by whom, and why. Assessments are separate from the claim and can change as evidence arrives.'],
    ['Evidence links', 'The evidence for and against the claim, each with the exact place quoted and the kind of source (primary, official record, testimony, secondary…).'],
    ['Evidence graph', 'The claim\'s sources and what depends on them, as a graph. Shows when several "sources" really trace back to one.'],
  ],
  records: [
    ['Scope', 'Choose the case (one list or source) to work on, or all of them.'],
    ['Record proposals awaiting review', 'One proposed record per person found in a source. Accept to record what the source says; reject with a reason.'],
    ['Candidate matches', 'Pairs of records from different sources that may be the same person. Decide same, different or unresolved, with a reason; every decision is kept with its history and can be revised.'],
    ['Roster', 'Everyone across all sources, grouped by the "same person" decisions, with each source\'s values side by side. Disagreements (two different ages, say) are shown, never silently resolved.'],
    ['Incidents (research leads)', 'People who share a place and a day: possible single events worth investigating together.'],
    ['Date conversion', 'Converts dates between calendars (for example Solar Hijri to Gregorian) and checks a stated weekday against the date.'],
  ],
  correspondence: [
    ['Conversations', 'Every exchange with an outside person or organization, grouped by thread.'],
    ['Conversation', 'One thread: messages in and out, their status and attachments.'],
    ['Compose', 'Write a message. Sending needs a sending grant; drafts written by agents always wait for a person to approve them.'],
    ['Dispatch queue', 'Messages approved and waiting to go out, with their status. Nothing is shown as sent until the mail provider confirms it.'],
    ['Sending grants', 'Who may send from which mailbox, to whom, and until when.'],
    ['Contacts', 'People and organizations you correspond with, with their consent and contact restrictions.'],
    ['Mailboxes', 'The email accounts PAM sends and receives through.'],
    ['Sealed mailboxes', 'Mailboxes whose incoming mail is sealed on arrival: encrypted for the researchers’ sealing keys, kept as a sealed record under a code name for the sender, then erased here, so a break-in finds only a tombstone. Without a registered sealing key nothing is erased and each message is listed under Needs attention. Only an administrator can change the list.'],
  ],
  editorial: [
    ['Editorial projects', 'Stories, reports and scripts being written from investigation findings.'],
    ['Documents', 'The documents of the selected project.'],
    ['Generate a draft from an investigation package', 'A model drafts text from a closed package. Every sentence must trace to the package; anything it cannot support is flagged for a person.'],
    ['Blocks', 'The document in blocks; each block shows the claims and evidence it rests on.'],
    ['Fact-check', 'Checks every statement against the knowledge records and lists what is unsupported, disputed or outdated.'],
    ['Revision history', 'Every change, who made it and why.'],
  ],
  production: [
    ['Production projects', 'Audio, video, images and music made from approved editorial work.'],
    ['New production project', 'Start a production from an approved revision.'],
    ['Providers', 'The rendering tools and services available, and what each may be used for.'],
    ['Project', 'The selected production in detail.'],
    ['Renders', 'Each rendered output, with the inputs and settings that produced it.'],
    ['Preview', 'Play or view a render before it goes further.'],
  ],
  rights: [
    ['Permissions', 'Consent and licences: who allowed what use of which material, until when. Use decisions are made against these.'],
    ['Record a permission', 'Record consent or a licence, with its limits and evidence. A person can withdraw their consent at any time.'],
    ['Use decisions', 'Every decision on whether something may be used for a purpose (research, publication…), with the reasons. Engines ask before using material.'],
    ['Holds', 'Blocks on use (legal holds, safety holds). A held item cannot be used until the hold is lifted.'],
  ],
  release: [
    ['Candidates', 'Packages being prepared for release to an audience, private or public.'],
    ['Build a candidate from an investigation package', 'Turn a package into a release candidate for a chosen audience and destination.'],
    ['Distribution history and follow-ups', 'Where and when each release went, and what followed.'],
    ['Destinations', 'Where releases can go: a private review portal, partners, the public.'],
    ['Leak report', 'Checks a candidate for material that must not leave: protected identities, restricted evidence, held items.'],
    ['Review', 'The candidate\'s contents and checks, for the reviewer.'],
    ['Accountability decision (required for public release)', 'A named person must record why the public interest justifies release and accept responsibility. Public release is impossible without it.'],
    ['Approval and release', 'Approve and release. Releases are versioned and recorded.'],
    ['Correction and withdrawal', 'Correct or withdraw a release; recipients and dependents are notified and the history stays visible.'],
  ],
  discovery: [
    ['Sources', 'Where PAM looks for material: websites, file lists, search engines, feeds. Each source has its access terms, rate limit and allowed sites; robots.txt is respected.'],
    ['Add a source', 'Register a new source and its rules before collecting from it.'],
    ['Collection runs', 'Each collection: what was found, captured, skipped (and why) or failed. Captured pages are stored unchanged as evidence.'],
    ['Acquisition receipts', 'Proof of each capture: address, time, fingerprint and the evidence record it became.'],
    ['Failures and gaps', 'What could not be collected and why (blocked, not found, robots.txt). Gaps are findings too.'],
    ['Contact leads', 'Possible contacts noticed during collection, for a person to consider. Nobody is contacted automatically.'],
  ],
  sealed: [
    ['How sealing works', 'Material from people at risk is encrypted in your browser before it is sent. The server keeps only scrambled text, a code name, the channel, the date and a fingerprint. A copy of the server reveals neither what was said nor who said it.'],
    ['Your sealing key', 'Your private key stays on this device; PAM holds only the public half. Keep the backup file and passphrase safe and separate: without them sealed material cannot be read if this device is lost.'],
    ['Source code names', 'Each person is a code name (S-1, S-2…) with a channel and a risk level. Never record names, numbers, addresses or anything that identifies them here; keep identities on your own devices.'],
    ['Add a sealed record', 'Paste a conversation or notes, or attach a file. It is encrypted here for every registered key, then stored as evidence. Facts drawn from it can cite it like any other evidence.'],
    ['Sealed records', 'Every sealed record. "Decrypt here" opens one on this device only and checks its fingerprint, which proves it is the original as sealed.'],
  ],
  'research-record': [
    ['Research record', 'Everything done to this project\'s research, kept so a later researcher, or anyone disputing the work, can see who did what, when, with which exact tool, why, and with what result. Nothing here can be changed or deleted.'],
    ['Research runs', 'One entry per execution of a script or agent: purpose, tools, command, times, result and the full output. Scripts and agents cannot change research outside a run.'],
    ['Tools', 'Every script or program used, identified by the fingerprint of its exact source, which is kept.'],
    ['Write journal', 'Every change made to this project, by anyone, with the run it belonged to. "Application" means it was made on these pages.'],
  ],
  resources: [
    ['Budgets', 'Limits on spending and usage, by organization, project, agent or run.'],
    ['Research lanes: measured effort against target', 'Time actually spent per line of research, against the intended share. Effort is measured, never used as a quota on outcomes.'],
    ['Usage', 'What was used, by whom, for what.'],
    ['Incidents', 'Overspending, failed charges and other problems.'],
    ['Invoices', 'Bills and credit notes.'],
  ],
  audit: [
    ['Filters', 'Narrow the audit trail by engine, person, record or time.'],
    ['Timeline', 'Every recorded action across the engines, in order, with who did it. Audit entries are chained so tampering shows.'],
  ],
  admin: [
    ['Provisioning', 'One-time setup that lets PAM\'s own workers act in this organization. Run it once for a new organization.'],
    ['Members and roles', 'Who belongs to the organization and what each may do in each project.'],
    ['Agents and agent tokens', 'Automated identities and their short-lived passes.'],
    ['Capability grants', 'Exact permissions given outside a role, for example the right to send from one mailbox.'],
    ['Compartments', 'Restricted areas inside a project; only people holding the compartment see its material.'],
    ['Roles', 'Named sets of permissions.'],
    ['Purposes', 'The access purposes (research, release, administration…) and what each allows.'],
  ],
  account: [
    ['Sign in on your phone', 'Shows a QR code that signs your phone in as you, once, within two minutes. Only scan it with a phone you own.'],
    ['Two-factor sign-in', 'Require a six-digit code from an authenticator app at sign-in. Keep the recovery codes somewhere safe.'],
  ],
};
