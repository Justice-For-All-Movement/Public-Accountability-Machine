# Sealed sources

People who talk to a PAM project can be endangered by what they say, and by being known to have said it. Sealed sources
keep their words readable only by the project's researchers, on the researchers' own devices, while keeping the record
of where every fact came from.

## What the server holds

| Held on the server | Not held on the server |
| --- | --- |
| Each researcher's **public** sealing key and its fingerprint | Private keys (they stay on the researcher's devices and in their backup file) |
| Source **code names** (S-1, S-2 …), channel, risk level, a non-identifying note | Names, phone numbers, usernames, addresses, photos — anything that identifies a source |
| Each sealed record: ciphertext (as evidence, E05), kind, date, code name, the keys it was sealed for | What was said or sent |
| A salted **commitment** (SHA-256) for each record | The salt, which is inside the ciphertext |

A complete copy of the server, its database and its storage therefore shows that source S-17 (high risk, Signal) gave a
conversation on a date — not what was said, and not who S-17 is.

## How it works (web/js/sealed-crypto.js)

- **Keys.** Each researcher creates an ECDH P-256 key pair in the browser. The private key is kept in the browser as a
  non-extractable key, and in a backup file encrypted with a passphrase (PBKDF2-SHA-256, 600,000 iterations, AES-256-GCM).
  Only the public key is sent to PAM.
- **Sealing.** Content is encrypted with a fresh AES-256-GCM key; that key is wrapped for every registered researcher key
  (ephemeral ECDH P-256, HKDF-SHA-256, AES-256-GCM). The server refuses anything that is not exactly such an envelope, and
  refuses envelopes sealed for keys not registered in the project.
- **Provenance.** The commitment is SHA-256 over a random salt and the canonical content. Anyone who can decrypt can show
  the record is the original as sealed ("fingerprint verified"); nobody else can learn anything from it, even for short
  messages. Sealed records are evidence, so facts cite them like any other source (cite the whole record — never put a
  quotation from a sealed record in clear text elsewhere).

## Rules for researchers

1. Create your key once per device you use, or restore it from your backup. Keep the backup file and passphrase apart
   (for example the file on a USB stick, the passphrase written down at home). If both are lost, sealed records sealed only
   for you cannot be read by anyone — by design.
2. Before the first record from a person, create a code name with the channel and the risk to them. Keep the link between
   code names and real identities off the server: in your Signal contacts, or in an encrypted file on your own device.
3. Facts drawn from a sealed record may be written as claims (they are what the project uses), but never with the
   source's identifying details, and never with long verbatim quotations that would identify the speaker.
4. Records are sealed for every key registered at the time. A researcher who joins later cannot read earlier records until
   someone who can re-seals them for the new key (planned; see below).

## What this does not protect against

- **A compromised server serving altered pages.** Someone in control of the server could change the web page to capture a
  key when it is next used. Signs: unexpected requests to register keys, fingerprints you do not recognise. Planned: a
  the offline reader below for reading; key creation and sealing still use pages served by the server.
- **Compromised devices.** A researcher's unlocked device, or a source's phone, reveals what is on it. Use disappearing
  messages on Signal and full-disk encryption.
- **Metadata outside PAM.** Signal, email and phone networks see who contacted whom. Prefer Signal usernames and the intake
  onion address for people connected to Iran or other repressive states.
- **Not yet sealed:** the intake application's own submissions (planned next: encrypt intake submissions in the
  participant's browser to the project keys), and email to mailboxes that are not marked sealed (see below).

## Sealed mailboxes (seal on arrival)

An administrator marks mailboxes as sealed (Correspondence page, "Sealed mailboxes"; project setting
`correspondence.sealedMailboxes`; `PUT /api/app/v1/correspondence/sealed-mailboxes { mailboxIds }`, `correspondence:admin`,
people only). For every message the correspondence engine (E03) receives in a sealed mailbox, PAM's worker
(`src/app/sealed-mail.ts`, reacting to E03 `message.received`):

1. reads the message once with PAM's service identity: text, HTML, attachments, and the headers (from, to, cc, subject,
   date, Message-ID), all of which go **inside** the ciphertext;
2. seals it on the server for every registered public sealing key (the server can seal, never open);
3. stores it as a sealed record (kind `conversation`, channel `email`, date of arrival) under a code name for the sender.
   One code per sender address: PAM recognises a returning sender only through
   `HMAC-SHA-256(SEALED_MAIL_HMAC_KEY, organization, project, address)` in `pam_app.sealed_mail_senders`; the address
   itself is not stored, and without the key the table reveals nothing. New codes are created with risk `high`;
4. asks E03 to erase the message (`eraseMessageContent`, `preservedAs` = the sealed record's evidence reference). E03
   removes the subject, text, HTML, addresses and names, the original and attachment bytes and everything derived from
   them, and shows "Content sealed and erased; preserved as E05:…" instead. E03 itself confirms with the evidence engine
   that the reference exists before erasing anything.

Safety rules: nothing is erased unless the sealed record is stored (each step is recorded in `pam_app.sealed_mail` before
the next one; a crash resumes at the step it reached). With **no sealing key registered**, nothing is sealed or erased:
the message stays readable in the mailbox and appears under "Needs attention" (`sealed mail waiting for keys`); it is
sealed and erased automatically once a researcher creates a key. Failures are retried with backoff and listed as
`sealed mail failed`. Replies in sealed mailboxes are never forwarded to the knowledge engine as proposals. PAM's service
identity needs the exact capability `correspondence:erase`, added to the `service_orchestrator` role by provisioning
(Administration → Run provisioning, or `npm run bootstrap-admin`).

Configuration: `SEALED_MAIL_HMAC_KEY` (at least 32 characters, random, kept secret, never changed — a new key means
returning senders get new code names). Without it mail is still sealed and erased, but each message gets a new code name
and an alert says so. `PAM_SEALED_MAIL_RETRY_MS` (default 30000) is the retry interval.

What sealing on arrival does **not** hide: that a message arrived, when, in which mailbox, and its Message-ID,
In-Reply-To and References headers (kept by E03 for threading; a Message-ID often names the sender's mail domain); the
mail provider's own copy (E03 reads mailboxes, it does not delete from them: configure the provider to delete or not keep
mail); that a recorded contact replied to a conversation PAM started (the outbound message and its recipient are not
sealed); an address that asked not to be contacted (kept as a suppression). Database row versions remain until
PostgreSQL vacuums them and stay in WAL, backups and point-in-time-restore history for their retention period; a
filesystem object store unlinks files without overwriting them, and a versioned S3 bucket keeps old versions. Mail that
arrived before a mailbox was marked sealed is not changed. Sealing happens on the server, so the server sees each message
briefly in clear while sealing it.

## Offline reader and re-sealing

- **Offline reader** — `tools/sealed-reader.html` is one self-contained file that opens sealed records with your key
  backup, entirely on your device. It loads nothing and its content-security policy forbids every network connection, so
  it does not depend on pages served by a PAM server (which closes the "altered page" risk above for reading). Save it
  once from the repository and check its SHA-256 with `shasum -a 256 sealed-reader.html`. Current fingerprint:
  `460c46e3b248367da74b140672e98dd972b1f03e7e2c4c57bfb4ad309d9548b4`. Download sealed files from the Sealed sources page ("Download sealed file").
- **Re-sealing** — a record is readable by the keys registered when it was sealed. When a researcher joins, anyone who can
  open a record uses "Re-seal for current keys": the record is decrypted and encrypted again on their device for every
  current key, with the same salt, so its fingerprint does not change and the server checks that. The earlier envelope
  stays in evidence storage.
- **Agents' research runs** left open by a restart are closed as interrupted when PAM starts.
