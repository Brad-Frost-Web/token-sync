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

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const OUT = join(ROOT, '.eddie-develop');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);

  return i > -1 ? process.argv[i + 1] : fallback;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`eddie:develop: "${command} ${args.join(' ')}" failed in ${cwd}`);
    process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const eddie = resolve(arg('eddie', join(ROOT, '..', 'eddie-design-system')));
  const ref = arg('ref', 'origin/develop');
  if (!existsSync(join(eddie, '.git'))) {
    console.error(`eddie:develop: no Eddie checkout at ${eddie}. Pass --eddie <path>.`);
    process.exit(1);
  }
  // Fetching updates remote-tracking refs only; nothing you have checked out moves.
  if (ref.startsWith('origin/')) run('git', ['fetch', 'origin', ref.slice('origin/'.length)], eddie);
  const commit = execFileSync('git', ['rev-parse', '--short', ref], { cwd: eddie, encoding: 'utf8' }).trim();
  console.log(`eddie:develop: building Eddie ${ref} (${commit}) into .eddie-develop/ — a few minutes`);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT);
  const archive = spawnSync('git', ['archive', ref], { cwd: eddie, maxBuffer: 1 << 30 });
  if (archive.status !== 0) {
    console.error(`eddie:develop: git archive ${ref} failed`);
    process.exit(1);
  }
  const tar = spawnSync('tar', ['-x', '-C', OUT], { input: archive.stdout });
  if (tar.status !== 0) process.exit(1);
  run('npm', ['ci', '--no-audit', '--no-fund'], OUT);
  run('npm', ['run', 'build'], OUT);
  writeFileSync(join(OUT, 'COMMIT'), `${ref} ${commit}\n`);
  console.log(`eddie:develop: done. npm start, then open http://127.0.0.1:4321/demo/customizer.html`);
}
