// npm run eddie:develop — build Eddie's unreleased develop branch for the demo.
//
// Eddie's theme customizer joins Token Sync rooms from eddie-design-system#2447,
// which is on develop but not yet in a release. This exports develop from your
// Eddie checkout (git archive: your working tree, branch and files are never
// touched), builds it into .eddie-develop/ here (gitignored), and the demo
// server then serves it at /demo/customizer.html.
//
//   npm run eddie:develop                       # Eddie at ../eddie-design-system
//   npm run eddie:develop -- --eddie ~/code/eddie --ref origin/develop
//
// Once a release carries #2447, the demo can load it from unpkg and this goes.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const OUT = join(ROOT, '.eddie-develop');

function fail(message) {
  console.error(`eddie:develop: ${message}`);
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) fail(`--${name} needs a value`);

  return value;
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env });
  if (result.status !== 0) {
    console.error(`eddie:develop: "${command} ${args.join(' ')}" failed in ${cwd}`);
    process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const eddie = resolve(arg('eddie', join(ROOT, '..', 'eddie-design-system')));
  const ref = arg('ref', 'origin/develop');
  if (!existsSync(join(eddie, '.git'))) fail(`no Eddie checkout at ${eddie}. Pass --eddie <path>.`);
  // Fetching updates remote-tracking refs only; nothing you have checked out moves.
  if (ref.startsWith('origin/')) run('git', ['fetch', 'origin', ref.slice('origin/'.length)], eddie);
  let commit;
  try {
    commit = execFileSync('git', ['rev-parse', '--short', '--end-of-options', ref], { cwd: eddie, encoding: 'utf8' }).trim();
  } catch {
    fail(`${ref} isn't a ref in ${eddie}`);
  }
  console.log(`eddie:develop: building Eddie ${ref} (${commit}) into .eddie-develop/ — a few minutes`);
  // Built beside the old one and swapped in only once it works, so a failed
  // build leaves the last good one in place.
  const next = `${OUT}.next`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next);
  await new Promise((resolveDone) => {
    // Piped, not buffered: the archive is tens of megabytes.
    const archive = spawn('git', ['archive', '--end-of-options', ref], { cwd: eddie, stdio: ['ignore', 'pipe', 'inherit'] });
    const tar = spawn('tar', ['-x', '-C', next], { stdio: ['pipe', 'inherit', 'inherit'] });
    archive.stdout.pipe(tar.stdin);
    let failed = false;
    const check = (what) => (code, signal) => {
      if (code !== 0 && !failed) {
        failed = true;
        fail(`${what} failed (${signal ?? `exit ${code}`})`);
      }
    };
    archive.on('close', check(`git archive ${ref}`));
    tar.on('close', (code, signal) => (check('tar')(code, signal), resolveDone()));
  });
  // HUSKY=0: Eddie's install would otherwise try to set up its git hooks in here.
  run('npm', ['ci', '--no-audit', '--no-fund'], next, { ...process.env, HUSKY: '0' });
  run('npm', ['run', 'build'], next);
  writeFileSync(join(next, 'COMMIT'), `${ref} ${commit}\n`);
  rmSync(OUT, { recursive: true, force: true });
  renameSync(next, OUT);
  console.log(`eddie:develop: done. npm start, then open http://127.0.0.1:4321/demo/customizer.html`);
}
