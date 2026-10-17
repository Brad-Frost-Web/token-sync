// npm run build — writes dist/token-sync.js and dist/bookmarklet.txt.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './bundle.js';
import { bookmarkletUrl, tokenSyncScript } from '../packages/bookmarklet/build.js';

const dist = join(REPO_ROOT, 'dist');
mkdirSync(dist, { recursive: true });
const script = tokenSyncScript();
const url = bookmarkletUrl();
writeFileSync(join(dist, 'token-sync.js'), script);
writeFileSync(join(dist, 'bookmarklet.txt'), `${url}\n`);
console.log(`dist/token-sync.js   ${(script.length / 1024).toFixed(1)} KB`);
console.log(`dist/bookmarklet.txt ${(url.length / 1024).toFixed(1)} KB`);
