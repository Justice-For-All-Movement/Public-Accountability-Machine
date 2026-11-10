#!/usr/bin/env node
// Materialises the engines named in engines.lock.json under ./engines/<short>.
//   --link <dir>   development: symlink sibling checkouts found in <dir> (lower-cased repo name, optional "-engine" suffix)
//   (default)      clone each repository at its pinned revision (a null revision is refused: nothing unpinned is installed)
//   --pin <dir>    write the current HEAD of each sibling checkout into engines.lock.json
// Then installs each engine's own dependencies (npm ci --ignore-scripts; engines are imported from TypeScript source).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'engines.lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : resolve(args[i + 1] ?? '.'); };
const run = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
const sibling = (dir, repo) => [repo.toLowerCase(), `${repo.toLowerCase()}-engine`].map((n) => join(dir, n)).find((p) => existsSync(join(p, '.git')));

const pinDir = flag('--pin');
if (pinDir) {
  for (const [short, e] of Object.entries(lock.engines)) {
    const path = sibling(pinDir, e.repository);
    if (!path) { console.error(`skip ${short}: no checkout in ${pinDir}`); continue; }
    e.revision = run('git', ['rev-parse', 'HEAD'], path);
    console.log(`${short} ${e.revision}`);
  }
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  process.exit(0);
}

const linkDir = flag('--link');
mkdirSync(join(root, 'engines'), { recursive: true });
let failed = 0;
for (const [short, e] of Object.entries(lock.engines)) {
  const target = join(root, 'engines', short);
  try {
    if (linkDir) {
      const path = sibling(linkDir, e.repository);
      if (!path) { console.error(`missing ${short}: no checkout of ${e.repository} in ${linkDir}`); failed++; continue; }
      let present = false; try { lstatSync(target); present = true; } catch { /* absent */ }
      if (!present) symlinkSync(path, target, 'dir');
    } else {
      if (!/^[0-9a-f]{40}$/.test(e.revision ?? '')) { console.error(`refusing ${short}: no pinned revision in engines.lock.json`); failed++; continue; }
      if (!existsSync(join(target, '.git'))) {
        mkdirSync(target, { recursive: true });
        run('git', ['init', '-q'], target);
        run('git', ['remote', 'add', 'origin', `https://github.com/${lock.owner}/${e.repository}.git`], target);
      }
      run('git', ['fetch', '-q', '--depth', '1', 'origin', e.revision], target);
      run('git', ['checkout', '-q', '--detach', e.revision], target);
    }
    if (e.external) { console.log(`${short}: external application (started separately; see docs)`); continue; }
    if (!existsSync(join(target, 'node_modules'))) run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], target);
    console.log(`${short}: ready`);
  } catch (error) { console.error(`failed ${short}: ${error.message}`); failed++; }
}
process.exit(failed === 0 ? 0 : 1);
