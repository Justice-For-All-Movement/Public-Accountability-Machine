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
- **Not yet sealed:** the intake application's own submissions and the correspondence engine's email (planned next:
  encrypt intake submissions in the participant's browser to the project keys, and seal inbound email on arrival).

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
