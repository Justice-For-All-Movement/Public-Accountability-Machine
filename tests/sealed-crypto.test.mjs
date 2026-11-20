// Sealed records: encryption round trip, recipients, commitment, tampering, key backup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, importPrivate, seal, open, backup, restore, keyId, reseal } from '../web/js/sealed-crypto.js';

test('a sealed record opens only with a recipient key, and its commitment proves the original', async () => {
  const a = await generateKeyPair(), b = await generateKeyPair(), outsider = await generateKeyPair();
  const content = { text: 'He loved rap and recorded songs in his room.', channel: 'signal' };
  const env = await seal(content, [{ id: a.id, publicJwk: a.publicJwk }, { id: b.id, publicJwk: b.publicJwk }]);
  assert.ok(!JSON.stringify(env).includes('recorded songs in his room'), 'no plaintext in the envelope');
  assert.equal(env.recipients.length, 2);
  for (const k of [a, b]) { const out = await open(env, k.id, await importPrivate(k.privateJwk)); assert.deepEqual(out.content, content); assert.equal(out.commitmentVerified, true); }
  await assert.rejects(open(env, outsider.id, await importPrivate(outsider.privateJwk)), /not sealed for your key/);
  // Same content sealed twice gives different commitments (salted): short messages cannot be guessed from them.
  const env2 = await seal(content, [{ id: a.id, publicJwk: a.publicJwk }]);
  assert.notEqual(env.commitment, env2.commitment);
  // Tampering with the ciphertext is detected.
  const bad = { ...env, ciphertext: env.ciphertext.slice(0, -8) + 'AAAAAAA=' };
  await assert.rejects(open(bad, a.id, await importPrivate(a.privateJwk)));
  // A changed commitment no longer verifies.
  const forged = await open({ ...env, commitment: '0'.repeat(64) }, a.id, await importPrivate(a.privateJwk));
  assert.equal(forged.commitmentVerified, false);
  // A recipient whose key does not match its fingerprint is refused (a substituted key).
  await assert.rejects(seal(content, [{ id: a.id, publicJwk: b.publicJwk }]), /does not match/);
  assert.equal(await keyId(a.publicJwk), a.id);
});

test('a key backup restores only with its passphrase', { timeout: 60_000 }, async () => {
  const k = await generateKeyPair();
  await assert.rejects(backup(k.privateJwk, k.publicJwk, 'short'), /12 characters/);
  const file = await backup(k.privateJwk, k.publicJwk, 'correct horse battery staple');
  assert.ok(!JSON.stringify(file).includes(k.privateJwk.d), 'the private key is not in the file in the clear');
  await assert.rejects(restore(file, 'wrong passphrase here'), /Wrong passphrase/);
  const r = await restore(file, 'correct horse battery staple');
  assert.equal(r.id, k.id);
  const env = await seal({ text: 'x' }, [{ id: k.id, publicJwk: k.publicJwk }]);
  assert.equal((await open(env, r.id, await importPrivate(r.privateJwk))).content.text, 'x');
});

test('re-sealing for a new researcher keeps the fingerprint and lets the new key read the record', async () => {
  const a = await generateKeyPair(), late = await generateKeyPair();
  const env = await seal({ text: 'notes' }, [{ id: a.id, publicJwk: a.publicJwk }]);
  await assert.rejects(open(env, late.id, await importPrivate(late.privateJwk)), /not sealed for your key/);
  const env2 = await reseal(env, a.id, await importPrivate(a.privateJwk), [{ id: a.id, publicJwk: a.publicJwk }, { id: late.id, publicJwk: late.publicJwk }]);
  assert.equal(env2.commitment, env.commitment);
  const out = await open(env2, late.id, await importPrivate(late.privateJwk));
  assert.equal(out.content.text, 'notes'); assert.equal(out.commitmentVerified, true);
});
